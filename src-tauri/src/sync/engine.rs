//! Vault Sync P3: the sync engine (no Tauri). Turns the merge engine (`vault_merge`, P1) and a
//! [`StorageProvider`] (P2) into sync cycles.
//!
//! One cycle ([`sync_once`]):
//! 1. list the store (`vault.meta`, `devices/*`, `blobs/*`);
//! 2. `vault.meta`: upload ours if missing/pending, adopt a newer verified one (password changed
//!    elsewhere), ignore (and repair) a rolled-back one; between two concurrent password changes
//!    the later one wins (see [`sync_meta`]);
//! 3. download snapshots whose provider revision changed, open + authenticate them, reject
//!    generations lower than already seen (rollback protection);
//! 4. download the attachment blobs they reference that this device lacks;
//! 5. safety backup before the first sync / before a large remote change;
//! 6. merge everything into the local vault (saved through the normal save path), rename path
//!    collisions ("Name (2)");
//! 7. upload new blobs, then this device's snapshot (generation + 1) when something changed or
//!    local changes are pending. A failed upload leaves `pending` set; nothing local is lost.
//!
//! Errors from the provider abort the cycle as [`SyncError::Provider`]; the scheduler decides
//! when to retry (`RateLimited` → after `retry_after_s`, `Offline` / exhausted 5xx → later).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;

use serde::Serialize;

use super::provider::{ProviderError, RemoteObject, StorageProvider};
use super::seal::{self, RemoteMeta, Snapshot, SyncKeys, META_NAME};
use super::state::{DeviceInfo, SyncState};
use crate::vault_core::{VaultKey, VaultMeta, VAULT_ID_LEN};
use crate::vault_db::{self as vdb, Db, Entry};
use crate::vault_hlc::Removal;
use crate::vault_merge::{self, MergeReport};

// Stable error codes (see the P3/P4 contract).
pub const ERR_NOT_CONFIGURED: &str = "SYNC_NOT_CONFIGURED";
pub const ERR_NOT_CONNECTED: &str = "SYNC_NOT_CONNECTED";
pub const ERR_AUTH: &str = "SYNC_AUTH";
pub const ERR_OFFLINE: &str = "SYNC_OFFLINE";
pub const ERR_REMOTE_DIFFERENT: &str = "REMOTE_VAULT_DIFFERENT";
pub const ERR_NO_REMOTE: &str = "NO_REMOTE_VAULT";
pub const ERR_WRONG_PASSWORD: &str = "WRONG_PASSWORD";
pub const ERR_LOCKED: &str = "VAULT_LOCKED";

/// Blobs of attachments removed longer ago than this are deleted from the store.
pub const BLOB_GC_AFTER_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub path: String,
    /// Device NAME whose version lost; empty when that device's name isn't known (never an id).
    pub from_device: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Provider(ProviderError),
    RemoteVaultDifferent,
    NoRemoteVault,
    WrongPassword,
    Local(String),
}

impl SyncError {
    /// The string a command returns: a contract code where the UI branches, else a message.
    pub fn message(&self) -> String {
        match self {
            SyncError::Provider(ProviderError::Auth) => ERR_AUTH.into(),
            SyncError::Provider(ProviderError::Offline) => ERR_OFFLINE.into(),
            SyncError::Provider(e) => e.to_string(),
            SyncError::RemoteVaultDifferent => ERR_REMOTE_DIFFERENT.into(),
            SyncError::NoRemoteVault => ERR_NO_REMOTE.into(),
            SyncError::WrongPassword => ERR_WRONG_PASSWORD.into(),
            SyncError::Local(m) => m.clone(),
        }
    }

    /// Human-readable text for `lastError` (never a bare code, never a token).
    pub fn describe(&self) -> String {
        match self {
            SyncError::Provider(e) => e.to_string(),
            SyncError::RemoteVaultDifferent => "Your storage holds a different vault.".into(),
            SyncError::NoRemoteVault => "There is no synced vault in your storage yet.".into(),
            SyncError::WrongPassword => "Wrong password.".into(),
            SyncError::Local(m) => m.clone(),
        }
    }
}

impl From<ProviderError> for SyncError {
    fn from(e: ProviderError) -> Self {
        SyncError::Provider(e)
    }
}

impl From<String> for SyncError {
    fn from(e: String) -> Self {
        SyncError::Local(e)
    }
}

/// The local vault as the engine sees it. The app implements it over `VaultState::with_db`
/// (load-modify-save under the store lock, normal atomic save path); tests use memory.
pub trait LocalVault: Sync {
    fn read_db<T>(&self, f: impl FnOnce(&Db) -> T) -> Result<T, String>;
    /// `f` returns its result and whether it changed the DB (a changed DB is saved).
    fn update_db<T>(&self, f: impl FnOnce(&mut Db) -> (T, bool)) -> Result<T, String>;
    /// The current local `vault.json`.
    fn meta(&self) -> Result<VaultMeta, String>;
    /// Replace the local `vault.json` (keeping the previous one for `PASSWORD_CHANGED_ELSEWHERE`).
    fn adopt_meta(&self, meta: &VaultMeta) -> Result<(), String>;
    /// Write a rotated `.nqbackup` safety copy of the vault as it is on disk now.
    fn safety_backup(&self, reason: &str) -> Result<Option<PathBuf>, String>;
    /// Counter of local (user) changes; it moves whenever the vault is changed outside sync.
    fn change_seq(&self) -> u64;
}

/// Everything one cycle needs besides the local vault and the state.
pub struct Ctx<'a> {
    pub provider: &'a dyn StorageProvider,
    pub keys: SyncKeys,
    pub device_id: String,
    pub device_name: String,
    pub now_ms: u64,
}

impl<'a> Ctx<'a> {
    pub fn new(provider: &'a dyn StorageProvider, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], device_id: &str, device_name: &str, now_ms: u64) -> Self {
        Ctx { provider, keys: SyncKeys::derive(key, vault_id), device_id: device_id.into(), device_name: device_name.into(), now_ms }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Fetch, merge, upload.
    Full,
    /// Upload only (best-effort final push before lock).
    PushOnly,
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub result: SyncResult,
    /// The local vault changed (UI reloads).
    pub changed_local: bool,
    /// Non-fatal problems for `lastError`.
    pub warnings: Vec<String>,
    /// Merged and saved, but the upload failed (`pending` stays set).
    pub upload_error: Option<SyncError>,
    pub backup: Option<PathBuf>,
    /// A newer `vault.meta` (password changed elsewhere) was adopted.
    pub meta_adopted: bool,
}

struct Listing {
    meta: Option<RemoteObject>,
    devices: BTreeMap<String, RemoteObject>,
    blobs: HashSet<String>,
}

async fn list_all(p: &dyn StorageProvider) -> Result<Listing, SyncError> {
    let mut l = Listing { meta: None, devices: BTreeMap::new(), blobs: HashSet::new() };
    for o in p.list("").await? {
        if o.name == META_NAME {
            l.meta = Some(o);
        } else if let Some(id) = seal::device_from_object(&o.name) {
            l.devices.insert(id.to_string(), o);
        } else if o.name.starts_with(seal::BLOBS_PREFIX) {
            l.blobs.insert(o.name);
        }
    }
    Ok(l)
}

/// A device's name as last read from its snapshot (`None` when unknown). Ids are never names.
fn device_name_of<'s>(st: &'s SyncState, id: &str) -> Option<&'s str> {
    st.devices.get(id).map(|d| d.name.trim()).filter(|n| !n.is_empty())
}

/// A device for warning text: its name, or "another PC" (never its raw id).
fn device_label(st: &SyncState, id: &str) -> String {
    device_name_of(st, id).map_or_else(|| "another PC".into(), str::to_string)
}

fn warn(out: &mut Vec<String>, msg: String) {
    if !out.contains(&msg) {
        out.push(msg);
    }
}

// ─── vault.meta ──────────────────────────────────────────────────────────────

async fn upload_meta<L: LocalVault>(ctx: &Ctx<'_>, local: &L, st: &mut SyncState, generation: u64) -> Result<(), SyncError> {
    let meta = local.meta()?;
    let obj = ctx.provider.put(META_NAME, &seal::seal_meta(&ctx.keys, &meta, generation)).await?;
    st.meta_agreed(generation);
    st.meta_revision = Some(obj.revision);
    Ok(())
}

/// Which of two different, verified metas wins (`true` = the remote one).
///
/// * `derived`: the remote meta is newer than everything this device agreed on and this device
///   changed nothing since, so it was made after ours (sequential): it wins, whatever the clocks say.
/// * Otherwise the two are concurrent changes (both made since the last generation both sides
///   knew, e.g. one PC was offline): the one whose password change / recovery reset happened LATER
///   wins, by `(changed_at_ms, changed_by)`.
///   Clock skew: the stamps are the changing devices' wall clocks, so a PC whose clock runs ahead
///   wins a near-simultaneous race even if its change was really a little earlier. That only
///   decides between two changes that were genuinely concurrent; sequential changes are ordered
///   by generation, and a device's own stamps never go backwards (`VaultMeta::stamp_change`).
/// * A meta without a stamp (written before this rule) falls back to the old rule: the higher
///   generation wins and a tie goes to the store.
fn remote_meta_wins(remote: &VaultMeta, remote_gen: u64, mine: &VaultMeta, st: &SyncState, derived: bool) -> bool {
    if derived {
        return true;
    }
    match (remote.change_stamp(), mine.change_stamp()) {
        (Some(r), Some(l)) => r > l,
        _ => remote_gen >= st.meta_generation,
    }
}

/// `vault.meta`, once per cycle. The adopt rule:
///
/// 1. Rollback protection: a remote meta whose generation is below the one this device last
///    agreed on with the store (`SyncState::meta_base`) is never adopted; ours is put back.
/// 2. Same content: nothing to do (the generations are brought in line).
/// 3. Different content: [`remote_meta_wins`] — newer-and-sequential wins, else the later change.
///    * Remote wins: it is adopted; the local `vault.json` it replaces is kept as the previous meta
///      (so the replaced password gives `PASSWORD_CHANGED_ELSEWHERE`) and a pending local change is
///      dropped (it never overwrites the winner).
///    * Local wins: ours is uploaded one generation above the remote one, so every other device
///      adopts it as a newer meta.
async fn sync_meta<L: LocalVault>(ctx: &Ctx<'_>, local: &L, st: &mut SyncState, obj: Option<&RemoteObject>, out: &mut Outcome) -> Result<(), SyncError> {
    let Some(o) = obj else {
        return upload_meta(ctx, local, st, st.meta_generation.max(1)).await;
    };
    if !st.meta_pending && st.meta_revision.as_deref() == Some(o.revision.as_str()) {
        return Ok(());
    }
    let data = match ctx.provider.get(META_NAME).await {
        Ok(d) => d,
        Err(ProviderError::NotFound) => return upload_meta(ctx, local, st, st.meta_generation.max(1)).await,
        Err(e) => return Err(e.into()),
    };
    let rm = match RemoteMeta::parse(&data) {
        Ok(m) => m,
        Err(e) => {
            warn(&mut out.warnings, format!("The synced vault key file couldn't be read ({e}); it was left as it is."));
            return Ok(());
        }
    };
    if rm.vault_id() != Some(*ctx.keys.vault_id()) {
        return Err(SyncError::RemoteVaultDifferent);
    }
    if let Err(e) = rm.verify(&ctx.keys) {
        warn(&mut out.warnings, format!("The synced vault key file couldn't be verified ({e}) and was ignored."));
        return Ok(());
    }
    let g = rm.generation;
    let pending = st.meta_pending;
    let base = st.meta_base();
    if g < base {
        if !pending {
            warn(&mut out.warnings, "An older copy of the synced vault key file was found and replaced.".into());
        }
        return upload_meta(ctx, local, st, st.meta_generation).await;
    }
    let mine = local.meta()?;
    if rm.meta == mine {
        st.meta_agreed(g);
        st.meta_revision = Some(o.revision.clone());
        return Ok(());
    }
    let derived = !pending && g > st.meta_generation;
    // A store that moved past what we agreed on while we also changed something: a real race.
    let concurrent = g > base || !pending;
    if remote_meta_wins(&rm.meta, g, &mine, st, derived) {
        local.adopt_meta(&rm.meta)?;
        out.meta_adopted = true;
        if pending {
            warn(&mut out.warnings, "The master password was also changed on another device, later than here; that change was kept. Use the newer password.".into());
        }
        st.meta_agreed(g);
        st.meta_revision = Some(o.revision.clone());
    } else {
        if concurrent {
            warn(&mut out.warnings, "The master password was also changed on another device; the later change, made on this device, was kept.".into());
        }
        upload_meta(ctx, local, st, (g + 1).max(st.meta_generation)).await?;
    }
    Ok(())
}

/// Prepares `st` to (re-)enable sync for local vault `vault_hex` against the store's meta.
/// A different remote vault is refused; another vault's old state is reset. Generations are
/// left as they are, so the cycle that follows adopts a remote meta with a higher generation, and
/// a password change made here since the last sync (pending, also while paused) competes with a
/// concurrent remote one by "the later change wins" (see [`sync_meta`]).
pub fn prepare_enable(st: &mut SyncState, vault_hex: &str, remote: Option<&RemoteMeta>) -> Result<(), SyncError> {
    if let Some(rm) = remote {
        if rm.meta.vault_id != vault_hex {
            return Err(SyncError::RemoteVaultDifferent);
        }
    }
    if st.vault_id.as_deref() != Some(vault_hex) {
        let own = st.own_generation;
        st.reset_for_vault(vault_hex, if remote.is_some() { 0 } else { 1 });
        st.own_generation = own;
    }
    st.meta_generation = st.meta_generation.max(if remote.is_some() { 0 } else { 1 });
    st.enabled = true;
    st.pending = true;
    st.forget_revisions();
    Ok(())
}

// ─── snapshots and blobs ─────────────────────────────────────────────────────

struct Fetched {
    device: String,
    snap: Snapshot,
    revision: String,
    /// All referenced attachment data is present (otherwise refetch next time).
    complete: bool,
}

async fn fetch_snapshots(ctx: &Ctx<'_>, st: &mut SyncState, listing: &Listing, use_cache: bool, warnings: &mut Vec<String>) -> Result<Vec<Fetched>, SyncError> {
    let mut out = vec![];
    for (dev, o) in &listing.devices {
        if use_cache && st.revisions.get(dev) == Some(&o.revision) {
            continue;
        }
        let data = match ctx.provider.get(&o.name).await {
            Ok(d) => d,
            Err(ProviderError::NotFound) => continue, // removed between list and get
            Err(e) => return Err(e.into()),
        };
        let snap = match seal::open_snapshot(&ctx.keys, dev, &data) {
            Ok(s) => s,
            Err(e) => {
                warn(warnings, format!("A synced copy from {} couldn't be verified and was ignored ({e}).", device_label(st, dev)));
                continue;
            }
        };
        let mine = *dev == ctx.device_id;
        let floor = st.seen.get(dev).copied().unwrap_or(0).max(if mine { st.own_generation } else { 0 });
        if snap.generation < floor {
            warn(warnings, format!(
                "An older copy from {} was ignored (generation {} < {floor}); the storage may have served stale data.",
                device_label(st, dev), snap.generation
            ));
            continue;
        }
        if mine && snap.generation > st.own_generation {
            st.own_generation = snap.generation; // this device's state was reset; continue above it
        }
        out.push(Fetched { device: dev.clone(), snap, revision: o.revision.clone(), complete: true });
    }
    Ok(out)
}

/// Fills in the attachment data the fetched snapshots reference and this device doesn't have
/// (`have` = attachment ids holding data locally, `removed` = removed locally). Attachments
/// whose blob can't be fetched are left out of that snapshot for now (retried next sync).
async fn fill_blobs(ctx: &Ctx<'_>, listing: &Listing, have: &HashSet<String>, removed: &HashSet<String>, fetched: &mut [Fetched], warnings: &mut Vec<String>) -> Result<(), SyncError> {
    let mut removed = removed.clone();
    for f in fetched.iter() {
        for e in f.snap.db.entries.values() {
            removed.extend(e.attachments.iter().filter(|a| a.removed.is_some()).map(|a| a.id.clone()));
        }
    }
    let mut cache: HashMap<String, Option<String>> = HashMap::new();
    let mut missing = false;
    for f in fetched.iter_mut() {
        for e in f.snap.db.entries.values_mut() {
            let mut drop_ids: Vec<String> = vec![];
            for a in e.attachments.iter_mut().filter(|a| a.removed.is_none() && a.data.is_empty()) {
                if have.contains(&a.id) || removed.contains(&a.id) {
                    continue;
                }
                if !cache.contains_key(&a.id) {
                    let name = ctx.keys.blob_name(&a.id);
                    let mut got = None;
                    if listing.blobs.contains(&name) {
                        match ctx.provider.get(&name).await {
                            Ok(d) => match seal::open_blob(&ctx.keys, &a.id, &d) {
                                Ok(p) => got = Some(vdb::b64_encode(&p)),
                                Err(e) => warn(warnings, format!("A synced attachment couldn't be verified and was skipped ({e}).")),
                            },
                            Err(e @ (ProviderError::Auth | ProviderError::Offline | ProviderError::RateLimited { .. })) => return Err(e.into()),
                            Err(_) => {}
                        }
                    }
                    cache.insert(a.id.clone(), got);
                }
                match &cache[&a.id] {
                    Some(d) => a.data = d.clone(),
                    None => drop_ids.push(a.id.clone()),
                }
            }
            if !drop_ids.is_empty() {
                e.attachments.retain(|a| !drop_ids.contains(&a.id));
                f.complete = false;
                missing = true;
            }
        }
    }
    if missing {
        warn(warnings, "Some attachments couldn't be downloaded yet; they'll be retried on the next sync.".into());
    }
    Ok(())
}

fn combine(fetched: &[Fetched]) -> Option<Db> {
    let mut it = fetched.iter();
    let first = it.next()?;
    let mut acc = first.snap.db.clone();
    for f in it {
        acc = vault_merge::merge(&acc, &f.snap.db);
    }
    Some(acc)
}

fn attachment_index(db: &Db) -> (HashSet<String>, HashSet<String>) {
    let (mut have, mut removed) = (HashSet::new(), HashSet::new());
    for e in db.entries.values() {
        for a in &e.attachments {
            if a.removed.is_some() {
                removed.insert(a.id.clone());
            } else if !a.data.is_empty() {
                have.insert(a.id.clone());
            }
        }
    }
    (have, removed)
}

fn record_fetched(st: &mut SyncState, fetched: &[Fetched]) {
    for f in fetched {
        let seen = st.seen.entry(f.device.clone()).or_insert(0);
        *seen = (*seen).max(f.snap.generation);
        if f.complete {
            st.revisions.insert(f.device.clone(), f.revision.clone());
        }
        st.devices.insert(f.device.clone(), DeviceInfo { name: f.snap.device_name.clone(), last_seen_ms: Some(f.snap.written_at_ms) });
    }
}

// ─── collisions, large changes ───────────────────────────────────────────────

fn occupied(db: &Db, path: &str) -> bool {
    let prefix = format!("{path}/");
    db.entries.values().any(|e| !e.deleted && (e.path == path || e.path.starts_with(&prefix)))
}

fn split_nqv(path: &str) -> (&str, &str) {
    if path.len() >= 4 && path[path.len() - 4..].eq_ignore_ascii_case(".nqv") {
        path.split_at(path.len() - 4)
    } else {
        (path, "")
    }
}

/// `a/Name.nqv` → `a/Name (2).nqv` (then 3, 4 …), first one not in use.
fn numbered_variant(db: &Db, path: &str) -> String {
    let (stem, ext) = split_nqv(path);
    (2u64..).map(|n| format!("{stem} ({n}){ext}")).find(|c| !occupied(db, c)).expect("unbounded")
}

/// `a/Name.nqv` → `a/Name (This PC).nqv` (then "This PC 2" …).
fn this_pc_variant(db: &Db, path: &str) -> String {
    let (stem, ext) = split_nqv(path);
    (1u64..)
        .map(|n| if n == 1 { format!("{stem} (This PC){ext}") } else { format!("{stem} (This PC {n}){ext}") })
        .find(|c| !occupied(db, c))
        .expect("unbounded")
}

/// Fixes the path collisions a merge can leave (two devices created the same name offline) with
/// normal stamped changes: the oldest entry keeps the name, later notes become "Name (2)";
/// duplicate empty folder records are folded into the first. Recycle-bin duplicates are left
/// alone (restore already picks a free name). Returns how many entries changed.
pub fn resolve_collisions(db: &mut Db) -> usize {
    let mut n = 0;
    for c in vault_merge::path_collisions(db) {
        if c.trashed {
            continue;
        }
        for id in &c.ids[1..] {
            let stamp = db.tick();
            if c.dir {
                if let Some(e) = db.entries.get_mut(id) {
                    e.tomb = Some(Removal { over: e.stamp.clone(), at: stamp });
                    e.fix_flags();
                }
            } else {
                let to = numbered_variant(db, &c.path);
                if let Some(e) = db.entries.get_mut(id) {
                    e.path = to;
                    e.meta_stamp = stamp;
                }
            }
            n += 1;
        }
    }
    n
}

/// A remote change big enough to warrant a safety copy first.
pub fn is_large_change(changed: usize, live: usize) -> bool {
    changed > 10 || (live >= 4 && changed * 4 > live)
}

// ─── the cycle ───────────────────────────────────────────────────────────────

struct Applied {
    report: MergeReport,
    renamed: usize,
    own: Option<Db>,
    uploads: Vec<(String, String)>,
    gc: Vec<String>,
    seq: u64,
}

/// One sync cycle. `st` is updated in place (the caller persists it).
pub async fn sync_once<L: LocalVault>(ctx: &Ctx<'_>, local: &L, st: &mut SyncState, mode: Mode) -> Result<Outcome, SyncError> {
    let mut out = Outcome::default();
    let listing = list_all(ctx.provider).await?;
    sync_meta(ctx, local, st, listing.meta.as_ref(), &mut out).await?;

    // Download and verify what changed elsewhere.
    let mut fetched = vec![];
    if mode == Mode::Full {
        fetched = fetch_snapshots(ctx, st, &listing, true, &mut out.warnings).await?;
        if !fetched.is_empty() {
            let (have, removed) = local.read_db(attachment_index)?;
            fill_blobs(ctx, &listing, &have, &removed, &mut fetched, &mut out.warnings).await?;
        }
    }
    let combined = combine(&fetched);

    // Safety copies.
    if !st.first_sync_done {
        if local.read_db(|db| !db.entries.is_empty())? {
            out.backup = local.safety_backup("first-sync")?;
        }
    } else if let Some(remote) = &combined {
        let (changed, live) = local.read_db(|db| {
            let mut probe = db.clone();
            let r = vault_merge::merge_into(&mut probe, remote);
            (r.removed + r.updated, db.entries.values().filter(|e| e.is_live()).count())
        })?;
        if is_large_change(changed, live) {
            out.backup = local.safety_backup("large-change")?;
        }
    }

    // Merge into the local vault (saved through the normal path when it changed).
    let me = ctx.device_id.clone();
    let must_upload = st.pending || st.own_generation == 0 || !listing.devices.contains_key(&me);
    let applied = local.update_db(|db| {
        let report = combined.as_ref().map(|r| vault_merge::merge_into(db, r)).unwrap_or_default();
        let renamed = resolve_collisions(db);
        let changed = report.changed || renamed > 0;
        let seq = local.change_seq();
        let upload = must_upload || changed;
        let mut uploads = vec![];
        let mut gc = vec![];
        for e in db.entries.values().filter(|e| !e.deleted) {
            for a in &e.attachments {
                let name = ctx.keys.blob_name(&a.id);
                if let Some(r) = &a.removed {
                    if ctx.now_ms.saturating_sub(r.wall) > BLOB_GC_AFTER_MS && listing.blobs.contains(&name) {
                        gc.push(name);
                    }
                } else if upload && !a.data.is_empty() && !listing.blobs.contains(&name) {
                    uploads.push((a.id.clone(), a.data.clone()));
                }
            }
        }
        let own = upload.then(|| seal::strip_attachment_data(db));
        (Applied { report, renamed, own, uploads, gc, seq }, changed)
    })?;
    record_fetched(st, &fetched);
    out.changed_local = applied.report.changed || applied.renamed > 0;
    out.result = SyncResult {
        added: applied.report.added,
        updated: applied.report.updated,
        removed: applied.report.removed,
        conflicts: {
            let mut v: Vec<SyncConflict> = vec![];
            for c in &applied.report.conflicts {
                let from_device = if c.from_device == me {
                    ctx.device_name.clone()
                } else {
                    device_name_of(st, &c.from_device).unwrap_or_default().to_string()
                };
                let sc = SyncConflict { path: c.path.clone(), from_device };
                if !v.contains(&sc) {
                    v.push(sc);
                }
            }
            v
        },
    };
    if mode == Mode::Full {
        let listed: HashSet<&String> = listing.devices.keys().collect();
        st.devices.retain(|id, _| *id == me || listed.contains(id));
    }

    // Upload: blobs first, then the snapshot that references them.
    if let Some(own) = applied.own {
        if let Err(e) = upload_own(ctx, st, own, &applied.uploads, &mut out.warnings).await {
            st.pending = true;
            out.upload_error = Some(e);
            return Ok(out);
        }
        st.pending = local.change_seq() != applied.seq;
        super::history::after_upload(ctx).await; // daily history copy + retention (best effort)
    } else {
        st.pending = st.pending || local.change_seq() != applied.seq;
    }
    for name in applied.gc {
        let _ = ctx.provider.delete(&name).await; // best effort
    }
    st.first_sync_done = true;
    st.last_synced_ms = Some(ctx.now_ms);
    Ok(out)
}

async fn upload_own(ctx: &Ctx<'_>, st: &mut SyncState, own: Db, uploads: &[(String, String)], warnings: &mut Vec<String>) -> Result<(), SyncError> {
    let max = ctx.provider.capabilities().max_object_bytes;
    for (id, data) in uploads {
        let Some(bytes) = vdb::b64_decode(data) else { continue };
        let sealed = seal::seal_blob(&ctx.keys, id, &bytes);
        if sealed.len() as u64 > max {
            warn(warnings, "An attachment is too large for your storage and wasn't synced.".into());
            continue;
        }
        match ctx.provider.put(&ctx.keys.blob_name(id), &sealed).await {
            Ok(_) => {}
            Err(ProviderError::TooLarge) => warn(warnings, "An attachment is too large for your storage and wasn't synced.".into()),
            Err(e) => return Err(e.into()),
        }
    }
    let generation = st.own_generation + 1;
    let snap = seal::new_snapshot(&ctx.device_id, &ctx.device_name, ctx.now_ms, generation, own);
    let sealed = seal::seal_snapshot(&ctx.keys, &snap)?;
    drop(snap);
    if sealed.len() as u64 > max {
        return Err(SyncError::Local("The vault is too large for your storage.".into()));
    }
    let obj = ctx.provider.put(&seal::device_object(&ctx.device_id), &sealed).await?;
    st.own_generation = generation;
    st.seen.insert(ctx.device_id.clone(), generation);
    st.revisions.insert(ctx.device_id.clone(), obj.revision);
    st.devices.insert(ctx.device_id.clone(), DeviceInfo { name: ctx.device_name.clone(), last_seen_ms: Some(ctx.now_ms) });
    Ok(())
}

// ─── devices list ────────────────────────────────────────────────────────────

/// One row of the devices list (`sync_devices`). `name` is empty when unknown — never an id.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRow {
    pub id: String,
    pub name: String,
    pub last_seen_ms: Option<u64>,
    pub this_device: bool,
}

/// The devices that have a snapshot in the store, this device (`me`, named `my_name`) first.
///
/// Names come from `known` (filled whenever a sync opens a snapshot). A device not known yet (e.g. on
/// a fresh install before its first sync) is named from its snapshot when `keys` is given (vault
/// unlocked) and remembered in `known`; otherwise, or when its snapshot can't be read, the name is
/// empty. Returns the rows and whether `known` changed (the caller persists it).
pub async fn list_devices(
    p: &dyn StorageProvider,
    keys: Option<&SyncKeys>,
    known: &mut BTreeMap<String, DeviceInfo>,
    me: &str,
    my_name: &str,
) -> Result<(Vec<DeviceRow>, bool), SyncError> {
    let objs = p.list(seal::DEVICES_PREFIX).await?;
    let mut rows = vec![];
    let mut learned = false;
    for o in &objs {
        let Some(id) = seal::device_from_object(&o.name) else { continue };
        let this = !me.is_empty() && id == me;
        let modified = o.modified_ms.map(|m| m.max(0) as u64);
        let has_name = known.get(id).is_some_and(|i| !i.name.trim().is_empty());
        if !this && !has_name {
            if let Some(keys) = keys {
                // Best effort: an unreadable / missing snapshot just leaves the name empty.
                if let Ok(data) = p.get(&o.name).await {
                    if let Ok(snap) = seal::open_snapshot(keys, id, &data) {
                        known.insert(id.to_string(), DeviceInfo { name: snap.device_name.trim().to_string(), last_seen_ms: Some(snap.written_at_ms) });
                        learned = true;
                    }
                }
            }
        }
        let info = known.get(id);
        rows.push(DeviceRow {
            id: id.to_string(),
            name: if this { my_name.trim().to_string() } else { info.map(|i| i.name.trim().to_string()).unwrap_or_default() },
            last_seen_ms: info.and_then(|i| i.last_seen_ms).or(modified),
            this_device: this,
        });
    }
    rows.sort_by_key(|r| !r.this_device); // stable: this PC first, the rest in store order
    Ok((rows, learned))
}

// ─── remote vault discovery, join, adopt ─────────────────────────────────────

/// The store's `vault.meta`, unauthenticated (`None` = no synced vault).
pub async fn fetch_meta(p: &dyn StorageProvider) -> Result<Option<RemoteMeta>, SyncError> {
    match p.get(META_NAME).await {
        Ok(d) => RemoteMeta::parse(&d).map(Some).map_err(|e| SyncError::Local(format!("The synced vault couldn't be read ({e})."))),
        Err(ProviderError::NotFound) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Authenticates a remote meta with the key unwrapped from it.
pub fn verify_meta(rm: &RemoteMeta, key: &VaultKey) -> Result<[u8; VAULT_ID_LEN], SyncError> {
    let id = rm.vault_id().ok_or_else(|| SyncError::Local("The synced vault key file is invalid.".into()))?;
    rm.verify(&SyncKeys::derive(key, &id)).map_err(|e| SyncError::Local(format!("The synced vault key file couldn't be verified ({e}).")))?;
    Ok(id)
}

/// What a join / adopt builds in memory before anything local is written.
pub struct Prepared {
    pub db: Db,
    /// Fresh state for the synced vault (generations / revisions seen while downloading).
    pub state: SyncState,
    pub counts: ImportCounts,
    pub warnings: Vec<String>,
}

/// Join / adopt, network part: verifies `rm` with `key`, downloads and merges every snapshot and
/// blob, and (adopt "import") adds `import_from`'s entries. Pure with respect to the local vault:
/// on any error nothing has been written, so the caller leaves the device exactly as it was.
pub async fn prepare_switch(
    p: &dyn StorageProvider,
    rm: &RemoteMeta,
    key: &VaultKey,
    device_id: &str,
    device_name: &str,
    now_ms: u64,
    import_from: Option<&Db>,
) -> Result<Prepared, SyncError> {
    let vault_id = verify_meta(rm, key)?;
    let ctx = Ctx::new(p, key, &vault_id, device_id, device_name, now_ms);
    let mut state = SyncState::default();
    state.reset_for_vault(&seal::vault_id_hex(&vault_id), rm.generation);
    let mut warnings = vec![];
    let mut db = download_vault(&ctx, &mut state, &mut warnings).await?;
    let counts = import_from.map(|l| import_local(&mut db, l)).unwrap_or_default();
    if counts.attachments_skipped > 0 {
        warnings.push(format!(
            "{} attachment(s) from this PC weren't imported because the vault's attachment limits would be exceeded; they are in the backup file.",
            counts.attachments_skipped
        ));
    }
    state.enabled = true;
    state.first_sync_done = true;
    state.pending = true;
    Ok(Prepared { db, state, counts, warnings })
}

/// Downloads every device snapshot (and their blobs) and merges them into one database whose
/// clock belongs to `ctx.device_id`. Records generations/revisions in `st`.
pub async fn download_vault(ctx: &Ctx<'_>, st: &mut SyncState, warnings: &mut Vec<String>) -> Result<Db, SyncError> {
    let listing = list_all(ctx.provider).await?;
    if listing.meta.is_none() {
        return Err(SyncError::NoRemoteVault);
    }
    let mut fetched = fetch_snapshots(ctx, st, &listing, false, warnings).await?;
    fill_blobs(ctx, &listing, &HashSet::new(), &HashSet::new(), &mut fetched, warnings).await?;
    let mut db = combine(&fetched).unwrap_or_else(Db::new);
    record_fetched(st, &fetched);
    db.device = ctx.device_id.clone();
    db.loaded_v = vdb::DB_VERSION;
    Ok(db)
}

/// What importing this PC's vault into the synced one did.
#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportCounts {
    pub imported: usize,
    pub skipped: usize,
    pub renamed: usize,
    /// Attachments left out because the vault limits (20 per note, 25 MB) would be exceeded.
    pub attachments_skipped: usize,
}

/// Adds `local`'s live entries to `target` (the synced vault, `target.device` set): identical
/// notes (same path, type and text) and existing folders are skipped; a different note at the same
/// path is kept as "Name (This PC)". Attachments come along within the vault limits. Every
/// imported entry gets fresh stamps from `target`'s clock, so it reaches every device.
pub fn import_local(target: &mut Db, local: &Db) -> ImportCounts {
    let mut c = ImportCounts::default();
    let mut items: Vec<&Entry> = local.entries.values().filter(|e| e.is_live()).collect();
    items.sort_by(|a, b| (!a.dir, &a.path).cmp(&(!b.dir, &b.path)));
    for src in items {
        let mut path = src.path.clone();
        if src.dir {
            if occupied(target, &path) {
                c.skipped += 1;
                continue;
            }
        } else if let Some(t) = target.get(&path) {
            if t.ext == src.ext && t.content == src.content {
                c.skipped += 1;
                continue;
            }
            path = this_pc_variant(target, &path);
            c.renamed += 1;
        } else if occupied(target, &path) {
            path = this_pc_variant(target, &path);
            c.renamed += 1;
        }
        let mut e = src.clone();
        if target.entries.contains_key(&e.id) {
            e.id = crate::vault_hlc::new_device_id(); // 32 random hex chars, like entry ids
        }
        e.path = path;
        e.trash = None;
        e.tomb = None;
        e.trashed_at = None;
        e.deleted = false;
        // Revision stamps came from the other vault's clock; fall back to their times (all older
        // than the fresh entry stamp below).
        for r in e.history.iter_mut() {
            r.stamp = None;
        }
        let mut kept = vec![];
        let mut total = target.attachments_total();
        for a in src.attachments.iter().filter(|a| a.is_live()) {
            if kept.len() >= vdb::MAX_ATTACH_PER_ENTRY || total + a.size > vdb::MAX_ATTACH_TOTAL {
                c.attachments_skipped += 1;
                continue;
            }
            let mut a = a.clone();
            a.stamp = target.tick();
            total += a.size;
            kept.push(a);
        }
        e.attachments = kept;
        // The entry's stamp comes after its attachments' (as with attach_add), so a later delete
        // that saw this version also covers them.
        let stamp = target.tick();
        e.stamp = stamp.clone();
        e.meta_stamp = stamp;
        target.entries.insert(e.id.clone(), e);
        c.imported += 1;
    }
    target.normalise();
    c
}

#[cfg(test)]
mod label_tests {
    use super::*;

    #[test]
    fn unknown_devices_are_never_labelled_with_their_id() {
        let mut st = SyncState::default();
        let id = "623dc26ac14b29a54ac147abce02d215";
        assert_eq!(device_name_of(&st, id), None);
        assert_eq!(device_label(&st, id), "another PC");
        st.devices.insert(id.into(), DeviceInfo { name: "  ".into(), last_seen_ms: None });
        assert_eq!(device_label(&st, id), "another PC", "blank names count as unknown");
        st.devices.insert(id.into(), DeviceInfo { name: "LAPTOP".into(), last_seen_ms: None });
        assert_eq!(device_label(&st, id), "LAPTOP");
    }
}
