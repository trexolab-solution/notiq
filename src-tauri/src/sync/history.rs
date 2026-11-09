//! Vault Sync: version history on the store ("Restore vault from a date").
//!
//! Each device's live snapshot (`devices/<id>.nqs`) is overwritten on every upload, so on its own
//! a bad change (a device pushing mass deletions) leaves nothing older to go back to. This module
//! keeps dated copies of the SAME sealed snapshot bytes (never plaintext, same seal and subject,
//! so they open exactly like a live snapshot):
//!
//! * `history/<device-id>/<yyyymmdd>.nqs` — a daily copy, at most one per device per UTC day, made
//!   after the first successful snapshot upload of that day ([`after_upload`]); never overwritten.
//! * `history/<device-id>/<yyyymmdd>-<hhmmssSSS>-<reason>.nqs` — an on-demand checkpoint of this
//!   device's live snapshot before a risky operation ([`checkpoint`]).
//!
//! Retention: copies older than [`KEEP_DAYS`] days are deleted, and each device keeps at most
//! [`MAX_CHECKPOINTS_PER_DEVICE`] checkpoints, so the extra storage is bounded by roughly
//! `devices × (KEEP_DAYS + 1 + MAX_CHECKPOINTS_PER_DEVICE)` snapshots (attachment data lives in the
//! shared blobs, not in snapshots). History upkeep is best effort: it never fails a sync cycle.
//!
//! Restoring ([`restore`]) opens and authenticates a copy like any snapshot, fetches the
//! attachments it references, writes a local safety backup, then MERGES it into the local vault
//! with [`Db::merge_backup`]: items from that date come back (re-stamped, so deletions made later
//! on any device can't remove them again), newer local edits stay current with the restored text
//! kept in their history, and nothing local is removed. The next normal sync uploads the result.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use serde::Serialize;

use super::engine::{Ctx, LocalVault, SyncError};
use super::provider::{validate_name, ProviderError, RemoteObject, StorageProvider};
use super::seal::{self, SyncKeys};
use super::state::DeviceInfo;
use crate::vault_db::{self as vdb, Db};

pub const HISTORY_PREFIX: &str = "history/";
const SUFFIX: &str = ".nqs";
/// Days of history kept per device (older copies are deleted during the sync cycle).
pub const KEEP_DAYS: u64 = 30;
/// On-demand checkpoints kept per device (oldest deleted first).
pub const MAX_CHECKPOINTS_PER_DEVICE: usize = 10;
/// The safety backup written before a restore.
pub const RESTORE_BACKUP_REASON: &str = "before-history-restore";
const DAY_MS: u64 = 86_400_000;
const MAX_REASON_LEN: usize = 40;

// ─── dates (UTC, no dependencies) ────────────────────────────────────────────

/// Days since 1970-01-01 → (year, month, day). Howard Hinnant's `civil_from_days`.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// UTC day number (days since the epoch) of `ms`.
pub fn day_of(ms: u64) -> u64 {
    ms / DAY_MS
}

/// `yyyymmdd` of a day number.
fn day_code(day: u64) -> String {
    let (y, m, d) = civil_from_days(day as i64);
    format!("{y:04}{m:02}{d:02}")
}

/// `yyyy-mm-dd` of a day number (what the UI shows / formats).
fn day_iso(day: u64) -> String {
    let (y, m, d) = civil_from_days(day as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// `yyyymmdd` → day number (only real calendar dates).
fn parse_day(s: &str) -> Option<u64> {
    if s.len() != 8 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (y, m, d) = (s[..4].parse::<i64>().ok()?, s[4..6].parse::<u32>().ok()?, s[6..].parse::<u32>().ok()?);
    let n = days_from_civil(y, m, d);
    (n >= 0 && civil_from_days(n) == (y, m, d)).then_some(n as u64)
}

// ─── names ───────────────────────────────────────────────────────────────────

/// A parsed history object name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointName {
    pub device: String,
    pub day: u64,
    /// Checkpoints only: when it was taken (Unix ms) and why.
    pub checkpoint: Option<(u64, String)>,
}

fn device_prefix(device: &str) -> String {
    format!("{HISTORY_PREFIX}{device}/")
}

pub fn daily_name(device: &str, day: u64) -> String {
    format!("{}{}{SUFFIX}", device_prefix(device), day_code(day))
}

/// Lowercase `[a-z0-9-]`, at most 40 chars; `manual` when nothing is left.
fn clean_reason(reason: &str) -> String {
    let mut r: String = reason
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    r.truncate(MAX_REASON_LEN);
    let r = r.trim_end_matches('-').to_string();
    if r.is_empty() { "manual".into() } else { r }
}

#[allow(dead_code)] // used by `checkpoint`
pub fn checkpoint_name(device: &str, at_ms: u64, reason: &str) -> String {
    let in_day = at_ms % DAY_MS;
    let (h, mi, s, ms) = (in_day / 3_600_000, in_day / 60_000 % 60, in_day / 1000 % 60, in_day % 1000);
    format!("{}{}-{h:02}{mi:02}{s:02}{ms:03}-{}{SUFFIX}", device_prefix(device), day_code(day_of(at_ms)), clean_reason(reason))
}

/// Parses `history/<device>/<yyyymmdd>[-<hhmmssSSS>-<reason>].nqs`; anything else is `None`
/// (and is never touched by the retention clean-up).
pub fn parse_name(name: &str) -> Option<PointName> {
    validate_name(name).ok()?;
    let (device, file) = name.strip_prefix(HISTORY_PREFIX)?.split_once('/')?;
    if !crate::vault_hlc::valid_device_id(device) {
        return None;
    }
    let stem = file.strip_suffix(SUFFIX)?;
    let day = parse_day(stem.get(..8)?)?;
    let rest = &stem[8..];
    let checkpoint = if rest.is_empty() {
        None
    } else {
        let rest = rest.strip_prefix('-')?;
        let (time, reason) = rest.split_once('-')?;
        if time.len() != 9 || !time.bytes().all(|b| b.is_ascii_digit()) || reason.is_empty() || reason != clean_reason(reason) {
            return None;
        }
        let n = |r: std::ops::Range<usize>| time[r].parse::<u64>().ok();
        let (h, mi, s, ms) = (n(0..2)?, n(2..4)?, n(4..6)?, n(6..9)?);
        if h > 23 || mi > 59 || s > 59 {
            return None;
        }
        Some((day * DAY_MS + h * 3_600_000 + mi * 60_000 + s * 1000 + ms, reason.to_string()))
    };
    Some(PointName { device: device.to_string(), day, checkpoint })
}

// ─── keeping copies ──────────────────────────────────────────────────────────

/// Copies this device's live snapshot to `name`. It is opened first (authenticated, this
/// vault, this device) so only a good snapshot is ever kept. `Ok(false)` = no live snapshot.
async fn copy_live(ctx: &Ctx<'_>, name: &str) -> Result<bool, SyncError> {
    validate_name(name)?;
    let data = match ctx.provider.get(&seal::device_object(&ctx.device_id)).await {
        Ok(d) => d,
        Err(ProviderError::NotFound) => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    seal::open_snapshot(&ctx.keys, &ctx.device_id, &data)
        .map_err(|e| SyncError::Local(format!("This device's synced copy couldn't be verified ({e}).")))?;
    if data.len() as u64 > ctx.provider.capabilities().max_object_bytes {
        return Err(ProviderError::TooLarge.into());
    }
    ctx.provider.put(name, &data).await?;
    Ok(true)
}

/// The cycle hook, called after this device's snapshot was uploaded: keeps today's daily copy
/// (once per UTC day) and, when it made one, cleans up old history. Best effort: problems are
/// only logged, the cycle never fails because of history.
pub async fn after_upload(ctx: &Ctx<'_>) {
    if let Err(e) = keep_daily(ctx).await {
        eprintln!("[sync] history copy skipped: {}", e.describe());
    }
}

async fn keep_daily(ctx: &Ctx<'_>) -> Result<(), SyncError> {
    let name = daily_name(&ctx.device_id, day_of(ctx.now_ms));
    if ctx.provider.list(&device_prefix(&ctx.device_id)).await?.iter().any(|o| o.name == name) {
        return Ok(());
    }
    if copy_live(ctx, &name).await? {
        gc(ctx.provider, ctx.now_ms).await;
    }
    Ok(())
}

/// An on-demand history copy of this device's live snapshot, e.g. before a risky operation
/// (`reason` is shortened to `[a-z0-9-]`). Returns the object name, or `None` when this device
/// has no snapshot in the store yet. Old copies are cleaned up afterwards (best effort).
pub async fn checkpoint(ctx: &Ctx<'_>, reason: &str) -> Result<Option<String>, SyncError> {
    let name = checkpoint_name(&ctx.device_id, ctx.now_ms, reason);
    if !copy_live(ctx, &name).await? {
        return Ok(None);
    }
    gc(ctx.provider, ctx.now_ms).await;
    Ok(Some(name))
}

/// Which history objects the retention rules delete: copies older than [`KEEP_DAYS`] days and,
/// per device, checkpoints beyond the newest [`MAX_CHECKPOINTS_PER_DEVICE`]. Unknown names
/// (not ours) are never selected.
pub fn expired(objects: &[RemoteObject], now_ms: u64) -> Vec<String> {
    let oldest_kept = day_of(now_ms).saturating_sub(KEEP_DAYS);
    let mut out = vec![];
    let mut checkpoints: HashMap<String, Vec<(u64, &str)>> = HashMap::new();
    for o in objects {
        let Some(p) = parse_name(&o.name) else { continue };
        if p.day < oldest_kept {
            out.push(o.name.clone());
        } else if let Some((at, _)) = p.checkpoint {
            checkpoints.entry(p.device).or_default().push((at, &o.name));
        }
    }
    for mut list in checkpoints.into_values() {
        list.sort();
        let extra = list.len().saturating_sub(MAX_CHECKPOINTS_PER_DEVICE);
        out.extend(list.into_iter().take(extra).map(|(_, n)| n.to_string()));
    }
    out
}

/// Deletes expired history (all devices: a removed device's copies age out too). Best effort.
async fn gc(p: &dyn StorageProvider, now_ms: u64) {
    let Ok(all) = p.list(HISTORY_PREFIX).await else { return };
    for name in expired(&all, now_ms) {
        let _ = p.delete(&name).await;
    }
}

// ─── listing ─────────────────────────────────────────────────────────────────

/// One restore point for the UI. `id` is opaque (pass it back to restore; never show it);
/// `device_name` is empty when unknown — never an id.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestorePoint {
    pub id: String,
    /// UTC date, `yyyy-mm-dd`.
    pub date: String,
    /// When the copy was taken (checkpoint) or stored (daily), Unix ms, when known.
    pub taken_ms: Option<u64>,
    pub device_name: String,
    pub this_device: bool,
    pub size: u64,
    /// `"daily"` or `"checkpoint"`.
    pub kind: &'static str,
}

/// Every restore point in the store, newest first. Device names come from `known`; a device
/// without a known name is named from its newest copy when `keys` is given (remembered in
/// `known`). Returns the points and whether `known` changed.
pub async fn list_points(
    p: &dyn StorageProvider,
    keys: Option<&SyncKeys>,
    known: &mut BTreeMap<String, DeviceInfo>,
    me: &str,
    my_name: &str,
) -> Result<(Vec<RestorePoint>, bool), SyncError> {
    let objs = p.list(HISTORY_PREFIX).await?;
    let mut parsed: Vec<(PointName, &RemoteObject)> = objs.iter().filter_map(|o| parse_name(&o.name).map(|n| (n, o))).collect();
    let sort_key = |n: &PointName, o: &RemoteObject| (n.day, n.checkpoint.as_ref().map(|c| c.0).or(o.modified_ms.map(|m| m.max(0) as u64)).unwrap_or(0));
    parsed.sort_by(|(a, ao), (b, bo)| sort_key(b, bo).cmp(&sort_key(a, ao)).then_with(|| ao.name.cmp(&bo.name)));
    let mut learned = false;
    if let Some(keys) = keys {
        let mut tried = HashSet::new();
        for (n, o) in &parsed {
            let named = known.get(&n.device).is_some_and(|i| !i.name.trim().is_empty());
            if n.device == me || named || !tried.insert(n.device.clone()) {
                continue;
            }
            // Best effort (newest copy first): an unreadable copy just leaves the name empty.
            if let Ok(data) = p.get(&o.name).await {
                if let Ok(snap) = seal::open_snapshot(keys, &n.device, &data) {
                    let last = known.get(&n.device).and_then(|i| i.last_seen_ms).or(Some(snap.written_at_ms));
                    known.insert(n.device.clone(), DeviceInfo { name: snap.device_name.trim().to_string(), last_seen_ms: last });
                    learned = true;
                }
            }
        }
    }
    let rows = parsed
        .into_iter()
        .map(|(n, o)| {
            let this = !me.is_empty() && n.device == me;
            RestorePoint {
                id: o.name.clone(),
                date: day_iso(n.day),
                taken_ms: n.checkpoint.as_ref().map(|c| c.0).or(o.modified_ms.map(|m| m.max(0) as u64)),
                device_name: if this { my_name.trim().to_string() } else { known.get(&n.device).map(|i| i.name.trim().to_string()).unwrap_or_default() },
                this_device: this,
                size: o.size,
                kind: if n.checkpoint.is_some() { "checkpoint" } else { "daily" },
            }
        })
        .collect();
    Ok((rows, learned))
}

// ─── restoring ───────────────────────────────────────────────────────────────

/// What a restore did (notes are counted; folders are merged but not counted).
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSummary {
    /// Notes that came back (missing or deleted here).
    pub added: u32,
    /// Notes that gained the restored version, tags or attachments.
    pub updated: u32,
    /// Notes that were already exactly like that.
    pub unchanged: u32,
    /// Notes changed here since: the restored version was kept in their history.
    pub kept_in_history: u32,
    /// Attachments whose data is no longer in the store (left out).
    pub attachments_missing: u32,
    /// The local safety copy written first.
    pub backup_path: Option<String>,
    /// UTC date of the restore point, `yyyy-mm-dd`.
    pub date: String,
}

/// Downloads and opens restore point `id` like a normal snapshot (authenticated with this vault's
/// keys, subject = its device, so another vault's or a tampered copy is rejected) and fills in the
/// attachment data it references from the store. `have` = attachment id → entry id of attachments
/// whose data the local vault already holds (not downloaded again). Attachments whose data can't
/// be found are left out and counted.
pub async fn load_point(ctx: &Ctx<'_>, id: &str, have: &HashMap<String, String>) -> Result<(Db, PointName, u32), SyncError> {
    let point = parse_name(id).ok_or_else(|| SyncError::Local("This restore point isn't valid.".into()))?;
    let data = match ctx.provider.get(id).await {
        Ok(d) => d,
        Err(ProviderError::NotFound) => return Err(SyncError::Local("This restore point no longer exists.".into())),
        Err(e) => return Err(e.into()),
    };
    let snap = seal::open_snapshot(&ctx.keys, &point.device, &data)
        .map_err(|e| SyncError::Local(format!("This restore point couldn't be verified ({e}); nothing was changed.")))?;
    drop(data);
    let mut db = snap.db;
    let mut missing = 0u32;
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    for e in db.entries.values_mut().filter(|e| !e.deleted) {
        let mut drop_ids = vec![];
        for a in e.attachments.iter_mut().filter(|a| a.is_live() && a.data.is_empty()) {
            if have.get(&a.id) == Some(&e.id) {
                continue; // the same note here already holds it (merge keeps that one)
            }
            if !cache.contains_key(&a.id) {
                let got = match ctx.provider.get(&ctx.keys.blob_name(&a.id)).await {
                    Ok(d) => seal::open_blob(&ctx.keys, &a.id, &d).ok().map(|p| vdb::b64_encode(&p)),
                    Err(e @ (ProviderError::Auth | ProviderError::Offline | ProviderError::RateLimited { .. })) => return Err(e.into()),
                    Err(_) => None,
                };
                cache.insert(a.id.clone(), got);
            }
            match &cache[&a.id] {
                Some(d) => a.data = d.clone(),
                None => drop_ids.push(a.id.clone()),
            }
        }
        if !drop_ids.is_empty() {
            missing += drop_ids.len() as u32;
            e.attachments.retain(|a| !drop_ids.contains(&a.id));
        }
    }
    Ok((db, point, missing))
}

/// Restores point `id` into the local vault: verify + download ([`load_point`]), write a local
/// safety backup ([`RESTORE_BACKUP_REASON`]), then merge with [`Db::merge_backup`] (restored
/// items win over later deletions; nothing local is removed). Nothing local changes when the
/// download or verification fails. The caller lets the next sync cycle upload the result.
pub async fn restore<L: LocalVault>(ctx: &Ctx<'_>, local: &L, id: &str) -> Result<RestoreSummary, SyncError> {
    let have: HashMap<String, String> = local.read_db(|db| {
        db.entries
            .values()
            .filter(|e| !e.deleted)
            .flat_map(|e| e.attachments.iter().filter(|a| a.is_live() && !a.data.is_empty()).map(|a| (a.id.clone(), e.id.clone())))
            .collect()
    })?;
    let (restored, point, missing) = load_point(ctx, id, &have).await?;
    let backup: Option<PathBuf> = local.safety_backup(RESTORE_BACKUP_REASON)?;
    let counts = local.update_db(|db| {
        let c = db.merge_backup(&restored);
        let changed = c.changed;
        (c, changed)
    })?;
    Ok(RestoreSummary {
        added: counts.added,
        updated: counts.updated,
        unchanged: counts.unchanged,
        kept_in_history: counts.kept_in_history,
        attachments_missing: missing,
        backup_path: backup.map(|p| p.to_string_lossy().into_owned()),
        date: day_iso(point.day),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEV: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn dates_round_trip() {
        assert_eq!(day_code(0), "19700101");
        assert_eq!(day_iso(day_of(1_762_646_400_000)), "2025-11-09"); // 2025-11-09T00:00Z
        for d in [0u64, 59, 60, 365, 10_957, 11_016, 20_401, 30_000] {
            assert_eq!(parse_day(&day_code(d)), Some(d));
        }
        for bad in ["20250230", "20251301", "2025110", "2025-1109", "abcdefgh"] {
            assert_eq!(parse_day(bad), None, "{bad}");
        }
    }

    #[test]
    fn names_are_valid_and_parse_back() {
        let day = day_of(1_762_646_400_000);
        let n = daily_name(DEV, day);
        assert_eq!(n, format!("history/{DEV}/20251109.nqs"));
        assert!(validate_name(&n).is_ok());
        assert_eq!(parse_name(&n), Some(PointName { device: DEV.into(), day, checkpoint: None }));

        let at = 1_762_646_400_000 + 13 * 3_600_000 + 5 * 60_000 + 7_000 + 42;
        let c = checkpoint_name(DEV, at, "Before Mass Delete!");
        assert_eq!(c, format!("history/{DEV}/20251109-130507042-before-mass-delete.nqs"));
        assert!(validate_name(&c).is_ok());
        assert_eq!(parse_name(&c), Some(PointName { device: DEV.into(), day, checkpoint: Some((at, "before-mass-delete".into())) }));
        assert!(checkpoint_name(DEV, at, "  ").ends_with("-manual.nqs"));
        assert!(validate_name(&checkpoint_name(DEV, at, &"x".repeat(500))).is_ok());

        for bad in [
            format!("devices/{DEV}.nqs"),
            format!("history/{DEV}/20251109"),
            format!("history/{DEV}/20251309.nqs"),
            "history/xyz/20251109.nqs".to_string(),
            format!("history/{DEV}/20251109-99-x.nqs"),
            format!("history/{DEV}/20251109-250000000-x.nqs"),
            format!("history/{DEV}/20251109-130507042-.nqs"),
            format!("history/{DEV}/a/20251109.nqs"),
        ] {
            assert_eq!(parse_name(&bad), None, "{bad}");
        }
    }

    fn obj(name: String) -> RemoteObject {
        RemoteObject { name, size: 1, revision: "1".into(), modified_ms: None }
    }

    #[test]
    fn retention_selects_old_copies_and_extra_checkpoints() {
        let now = 1_762_646_400_000 + 3_600_000;
        let today = day_of(now);
        let mut objs: Vec<RemoteObject> = (0..=KEEP_DAYS + 3).map(|back| obj(daily_name(DEV, today - back))).collect();
        objs.push(obj(format!("history/{DEV}/notes.txt")));
        for i in 0..(MAX_CHECKPOINTS_PER_DEVICE as u64 + 2) {
            objs.push(obj(checkpoint_name(DEV, now - 1000 * (i + 1), "x")));
        }
        objs.push(obj(checkpoint_name(DEV, now - (KEEP_DAYS + 2) * DAY_MS, "old")));
        let mut gone = expired(&objs, now);
        gone.sort();
        let mut want: Vec<String> = (KEEP_DAYS + 1..=KEEP_DAYS + 3).map(|b| daily_name(DEV, today - b)).collect();
        want.push(checkpoint_name(DEV, now - (KEEP_DAYS + 2) * DAY_MS, "old"));
        want.push(checkpoint_name(DEV, now - 1000 * (MAX_CHECKPOINTS_PER_DEVICE as u64 + 2), "x"));
        want.push(checkpoint_name(DEV, now - 1000 * (MAX_CHECKPOINTS_PER_DEVICE as u64 + 1), "x"));
        want.sort();
        assert_eq!(gone, want);
    }
}
