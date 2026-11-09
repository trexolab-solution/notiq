//! Vault Sync P3: per-device sync settings (`<app-data>/vault-sync.json`) and local safety backups.
//!
//! Nothing here is secret: tokens stay in the OS keychain (see `gdrive.rs`), the vault key only in
//! memory. The file holds what this device needs to sync correctly: whether sync is on, the device
//! name, generations (rollback protection), and whether local changes still wait for upload.

use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};

pub const STATE_FILE: &str = "vault-sync.json";
/// Folder (in app data) for sync safety copies; separate from user backups so neither rotates the other.
pub const SAFETY_DIR: &str = "vault-sync-backups";
/// Rotated safety copies kept.
pub const SAFETY_KEEP: usize = 5;
const SAFETY_PREFIX: &str = "safety-";
/// Prefix of the copy made before replacing/importing a local vault (never rotated away).
const LOCAL_PREFIX: &str = "local-vault-";
pub const MAX_DEVICE_NAME: usize = 40;

/// What this device knows about another device (from its snapshots).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceInfo {
    pub name: String,
    /// When that device last wrote its snapshot (its clock, Unix ms).
    pub last_seen_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncState {
    /// Live sync turned on for this vault on this device.
    pub enabled: bool,
    /// Connected provider id (`"gdrive"`), `None` = not connected.
    pub provider: Option<String>,
    /// Account label for display ("you@gmail.com").
    pub account: Option<String>,
    /// User-chosen device name (`None` = the OS host name).
    pub device_name: Option<String>,
    pub last_synced_ms: Option<u64>,
    pub last_error: Option<String>,
    /// Local changes not yet uploaded (survives restarts).
    pub pending: bool,
    /// Hex id of the vault that sync was enabled for.
    pub vault_id: Option<String>,
    /// Generation of this device's newest uploaded snapshot.
    pub own_generation: u64,
    /// Highest snapshot generation seen per device (rollback protection).
    pub seen: BTreeMap<String, u64>,
    /// Generation of the local `vault.json` as a `vault.meta` (highest seen).
    pub meta_generation: u64,
    /// The local `vault.json` changed (password change) and must be uploaded.
    pub meta_pending: bool,
    /// The `vault.meta` generation this device and the store last agreed on (uploaded, adopted or
    /// found identical). A pending local change sits above it; a remote meta below it is a
    /// rollback, one at or above it is a concurrent change. `None` (state from before 0.9.0's
    /// "later change wins"): taken as `meta_generation - 1` while a change is pending.
    pub meta_synced_generation: Option<u64>,
    /// A safety backup was taken before this device's first sync.
    pub first_sync_done: bool,
    /// Names / last-seen of devices, from their snapshots.
    pub devices: BTreeMap<String, DeviceInfo>,
    /// This PC was disconnected from the store (`sync_disconnect`) or never joined it: the next
    /// enable against the same vault is a Drive-first join (see `engine::sync_once`).
    pub detached: bool,
    /// When this PC was detached (Unix ms; `None` = unknown). Local changes after it are "kept".
    pub detached_at_ms: Option<u64>,
    /// Sync was resumed after a pause: the first upload that would remove anything live in the
    /// store waits for the user's confirmation (cleared by the first upload).
    pub resume_guard: bool,

    // Memory only: provider revisions already merged, so unchanged objects aren't downloaded again.
    // Cleared on every unlock / app start, which gives a full re-merge per session.
    #[serde(skip)]
    pub revisions: BTreeMap<String, String>,
    #[serde(skip)]
    pub meta_revision: Option<String>,
    /// Memory only: per device, the revision and a content-free skeleton of the snapshot last read
    /// (or uploaded). Their merge is the store's combined state, which the outbound guard checks.
    #[serde(skip)]
    pub remote_cache: RemoteCache,
}

/// Skeletons of the store's snapshots (see `SyncState::remote_cache`). Never compared or
/// persisted: two states are equal whatever their caches hold.
#[derive(Clone, Debug, Default)]
pub struct RemoteCache(pub BTreeMap<String, (String, crate::vault_db::Db)>);

impl PartialEq for RemoteCache {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}
impl Eq for RemoteCache {}

impl SyncState {
    pub fn load(dir: &Path) -> SyncState {
        fs::read_to_string(dir.join(STATE_FILE))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, dir: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::vault::atomic_write(&dir.join(STATE_FILE), json.as_bytes())
    }

    /// Forget per-session caches (forces a full re-merge on the next sync).
    pub fn forget_revisions(&mut self) {
        self.revisions.clear();
        self.meta_revision = None;
        self.remote_cache = RemoteCache::default();
    }

    /// Reset everything tied to one remote vault (a different vault is adopted / joined).
    pub fn reset_for_vault(&mut self, vault_id_hex: &str, meta_generation: u64) {
        self.vault_id = Some(vault_id_hex.into());
        self.seen.clear();
        self.devices.clear();
        self.meta_generation = meta_generation;
        self.meta_pending = false;
        self.meta_synced_generation = None;
        self.forget_revisions();
    }

    /// The store and this device agree on `vault.meta` at `generation`.
    pub fn meta_agreed(&mut self, generation: u64) {
        self.meta_generation = generation;
        self.meta_synced_generation = Some(generation);
        self.meta_pending = false;
    }

    /// The generation this device last agreed on with the store (see `meta_synced_generation`).
    pub fn meta_base(&self) -> u64 {
        if !self.meta_pending {
            return self.meta_generation;
        }
        self.meta_synced_generation.unwrap_or(self.meta_generation.saturating_sub(1)).min(self.meta_generation)
    }

    /// The master password was changed (or reset) on this device. `ours`: sync was set up for this
    /// very vault (on, or paused). The change is uploaded on the next cycle above the synced
    /// generation; against a concurrent change made elsewhere the later change wins (see
    /// `engine::sync_meta`). Returns false when the change has nothing to do with sync.
    pub fn note_local_meta_change(&mut self, ours: bool) -> bool {
        if !self.enabled && !ours {
            return false;
        }
        if !self.meta_pending {
            self.meta_synced_generation = Some(self.meta_generation);
        }
        // Every change bumps the generation, so a cycle running meanwhile can tell (`finish`).
        self.meta_generation += 1;
        self.meta_pending = true;
        true
    }
}

/// Trims and checks a device name (1–40 characters, no control characters).
pub fn clean_device_name(name: &str) -> Result<String, String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    let len = n.chars().count();
    if len == 0 || len > MAX_DEVICE_NAME {
        return Err(format!("The device name must be 1–{MAX_DEVICE_NAME} characters"));
    }
    Ok(n)
}

/// The OS host name, the default device name.
pub fn host_name() -> String {
    ["COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|s| s.trim().chars().take(MAX_DEVICE_NAME).collect::<String>())
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| "This device".into())
}

// ─── safety backups ──────────────────────────────────────────────────────────

fn write_container(path: &Path, meta_json: &[u8], db_bytes: &[u8]) -> Result<(), String> {
    let c = crate::vault_backup::build_container(meta_json, db_bytes);
    crate::vault_backup::parse_container(&c)?; // never write a copy we couldn't restore
    crate::vault::atomic_write(path, &c)
}

/// Writes a rotated safety copy (`.nqbackup`, the normal backup format) of the given vault files
/// into `<app_data>/vault-sync-backups/` and keeps the newest [`SAFETY_KEEP`].
pub fn write_safety_backup(app_data: &Path, meta_json: &[u8], db_bytes: &[u8], reason: &str, now_ms: u64) -> Result<PathBuf, String> {
    let dir = app_data.join(SAFETY_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let reason: String = reason.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    let mut path = dir.join(format!("{SAFETY_PREFIX}{now_ms:015}-{reason}.nqbackup"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("{SAFETY_PREFIX}{now_ms:015}-{reason}-{n}.nqbackup"));
    }
    write_container(&path, meta_json, db_bytes)?;
    let mut all: Vec<PathBuf> = fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(SAFETY_PREFIX) && n.ends_with(".nqbackup")))
        .collect();
    all.sort(); // oldest first (the time is zero-padded)
    // Routine copies rotate among themselves; each important reason keeps its own newest few.
    let mut groups: BTreeMap<Option<String>, Vec<PathBuf>> = BTreeMap::new();
    for p in all {
        let r = p.file_name().and_then(|n| n.to_str()).and_then(safety_reason).filter(|r| is_important_reason(r));
        groups.entry(r).or_default().push(p);
    }
    for (reason, mut files) in groups {
        let keep = if reason.is_some() { IMPORTANT_KEEP } else { SAFETY_KEEP };
        while files.len() > keep {
            let _ = fs::remove_file(files.remove(0));
        }
    }
    Ok(path)
}

/// Copies kept per important reason (see [`is_important_reason`]).
pub const IMPORTANT_KEEP: usize = 3;

/// Safety copies that routine ones never rotate away: before the first sync, before the
/// Drive-first join, and copies of the store's state (`remote-*`).
pub fn is_important_reason(reason: &str) -> bool {
    reason == "first-sync" || reason == "drive-first" || reason.starts_with("remote-")
}

/// `safety-000001700000000-remote-before-deletes-2.nqbackup` → `remote-before-deletes`.
fn safety_reason(name: &str) -> Option<String> {
    let rest = name.strip_prefix(SAFETY_PREFIX)?.strip_suffix(".nqbackup")?;
    let (_, reason) = rest.split_once('-')?;
    let reason = match reason.rsplit_once('-') {
        Some((head, n)) if !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) => head,
        _ => reason,
    };
    Some(reason.to_string())
}

/// The copy made before this device's local vault is replaced or imported (`sync_adopt_remote`).
/// Not rotated: it is the user's only copy of the old vault's key file.
pub fn write_local_vault_backup(app_data: &Path, meta_json: &[u8], db_bytes: &[u8], now_ms: u64) -> Result<PathBuf, String> {
    let dir = app_data.join(SAFETY_DIR);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{LOCAL_PREFIX}{now_ms:015}.nqbackup"));
    write_container(&path, meta_json, db_bytes)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_core::{create_vault, KdfParams};

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nq-syncstate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn vault_files() -> (Vec<u8>, Vec<u8>) {
        let (meta, key, _) = create_vault("a-long-test-password", KdfParams { m_kib: 64, t: 1, p: 1 }).unwrap();
        let db = crate::vault_db::Db::new();
        (meta.to_json().into_bytes(), db.seal(&key, &meta.vault_id_bytes().unwrap()).unwrap())
    }

    #[test]
    fn state_roundtrips_without_session_caches() {
        let d = tmp("rt");
        let mut s = SyncState { enabled: true, device_name: Some("Desk".into()), own_generation: 4, ..Default::default() };
        s.seen.insert("x".into(), 9);
        s.revisions.insert("x".into(), "r1".into());
        s.save(&d).unwrap();
        let back = SyncState::load(&d);
        assert_eq!(back.own_generation, 4);
        assert_eq!(back.seen["x"], 9);
        assert!(back.revisions.is_empty(), "revisions are memory only");
        let raw = fs::read_to_string(d.join(STATE_FILE)).unwrap();
        assert!(raw.contains("\"ownGeneration\"") && !raw.contains("revisions"));
        assert_eq!(SyncState::load(&tmp("missing")), SyncState::default());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn device_names_are_checked() {
        assert_eq!(clean_device_name("  Office PC ").unwrap(), "Office PC");
        assert!(clean_device_name("   ").is_err());
        assert!(clean_device_name(&"x".repeat(41)).is_err());
        assert!(clean_device_name(&"é".repeat(40)).is_ok());
        assert!(!host_name().is_empty());
    }

    #[test]
    fn safety_backups_rotate_and_local_copies_stay() {
        let d = tmp("safety");
        let (m, db) = vault_files();
        let local = write_local_vault_backup(&d, &m, &db, 1).unwrap();
        let mut paths = vec![];
        for i in 0..8u64 {
            paths.push(write_safety_backup(&d, &m, &db, "large-change", 1000 + i).unwrap());
        }
        let left: Vec<_> = fs::read_dir(d.join(SAFETY_DIR)).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(left.len(), SAFETY_KEEP + 1);
        assert!(local.exists(), "the local-vault copy is never rotated");
        assert!(!paths[0].exists() && paths[7].exists());
        // Restorable with the normal backup format.
        assert!(crate::vault_backup::parse_container(&fs::read(&paths[7]).unwrap()).is_ok());
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn important_safety_backups_survive_routine_rotation() {
        let d = tmp("important");
        let (m, db) = vault_files();
        let first = write_safety_backup(&d, &m, &db, "first-sync", 1).unwrap();
        let mut remote = vec![];
        for i in 0..5u64 {
            remote.push(write_safety_backup(&d, &m, &db, "remote-before-deletes", 10 + i).unwrap());
        }
        // Same millisecond: the "-2" suffix still counts as the same reason.
        let dup = write_safety_backup(&d, &m, &db, "remote-before-deletes", 14).unwrap();
        assert!(dup.to_string_lossy().ends_with("-remote-before-deletes-2.nqbackup"));
        for i in 0..20u64 {
            write_safety_backup(&d, &m, &db, "large-change", 100 + i).unwrap();
        }
        assert!(first.exists(), "first-sync copies are not rotated away by routine ones");
        assert!(dup.exists() && remote[4].exists() && remote[3].exists());
        assert!(!remote[0].exists(), "only the newest {IMPORTANT_KEEP} of a reason are kept");
        let left = fs::read_dir(d.join(SAFETY_DIR)).unwrap().count();
        assert_eq!(left, 1 + IMPORTANT_KEEP + SAFETY_KEEP);
        assert_eq!(safety_reason("safety-000000000000001-drive-first.nqbackup").as_deref(), Some("drive-first"));
        assert!(is_important_reason("remote-before-join") && !is_important_reason("large-change"));
        let _ = fs::remove_dir_all(d);
    }
}
