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
    /// A safety backup was taken before this device's first sync.
    pub first_sync_done: bool,
    /// Names / last-seen of devices, from their snapshots.
    pub devices: BTreeMap<String, DeviceInfo>,

    // Memory only: provider revisions already merged, so unchanged objects aren't downloaded again.
    // Cleared on every unlock / app start, which gives a full re-merge per session.
    #[serde(skip)]
    pub revisions: BTreeMap<String, String>,
    #[serde(skip)]
    pub meta_revision: Option<String>,
}

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
    }

    /// Reset everything tied to one remote vault (a different vault is adopted / joined).
    pub fn reset_for_vault(&mut self, vault_id_hex: &str, meta_generation: u64) {
        self.vault_id = Some(vault_id_hex.into());
        self.seen.clear();
        self.devices.clear();
        self.meta_generation = meta_generation;
        self.meta_pending = false;
        self.forget_revisions();
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
    all.sort();
    while all.len() > SAFETY_KEEP {
        let _ = fs::remove_file(all.remove(0));
    }
    Ok(path)
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
            paths.push(write_safety_backup(&d, &m, &db, "first-sync", 1000 + i).unwrap());
        }
        let left: Vec<_> = fs::read_dir(d.join(SAFETY_DIR)).unwrap().flatten().map(|e| e.path()).collect();
        assert_eq!(left.len(), SAFETY_KEEP + 1);
        assert!(local.exists(), "the local-vault copy is never rotated");
        assert!(!paths[0].exists() && paths[7].exists());
        // Restorable with the normal backup format.
        assert!(crate::vault_backup::parse_container(&fs::read(&paths[7]).unwrap()).is_ok());
        let _ = fs::remove_dir_all(d);
    }
}
