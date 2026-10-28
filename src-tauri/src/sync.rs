//! Storage-agnostic two-way sync for Secure Vault notes.
//!
//! The engine here knows nothing about Telegram or Google Drive. A [`Backend`]
//! only stores opaque blobs: `put` / `get` / `delete`, plus one small "sync
//! state" document that holds the vault key file (`vault.json`, which only has
//! password/recovery-wrapped keys) and a manifest sealed with the vault key.
//! Notes are merged three-way, using the last-synced hash as the base; when both
//! sides changed, the newer copy wins and the other is kept as a
//! "(conflict …)" file. Sync never deletes anything.

use std::{collections::HashMap, fs, path::{Path, PathBuf}};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};


use crate::gdrive::GDrive;
use crate::telegram::TgStore;
use crate::vault::{self, atomic_write, VaultState};
use crate::vault_core as vc;
use crate::vault_db::{self as vdb, DB_EXT};

const INDEX_FILE: &str = "sync_index.json";
const PROVIDER_FILE: &str = "sync_provider.json";
/// Stay under the smallest provider limit (Telegram bots download up to 20 MB).
pub const MAX_FILE: u64 = 19 * 1024 * 1024;
const MAX_DEPTH: usize = 6;
const STATE_MAGIC: &[u8; 4] = b"NQS1";

// ─── backends ────────────────────────────────────────────────────────────────

/// Where encrypted blobs live. Add a variant (and its arms) for a new provider.
pub enum Backend {
    Telegram(TgStore),
    Drive(GDrive),
}

impl Backend {
    pub async fn get(&self, id: &str) -> Result<Vec<u8>, String> {
        match self {
            Backend::Telegram(b) => b.get(id).await,
            Backend::Drive(b) => b.get(id).await,
        }
    }
    /// Best effort; failures are ignored.
    pub async fn delete(&self, id: &str) {
        match self {
            Backend::Telegram(b) => b.delete(id).await,
            Backend::Drive(b) => b.delete(id).await,
        }
    }
    /// The current sync-state document, if one exists.
    pub async fn read_state(&self) -> Result<Option<Vec<u8>>, String> {
        match self {
            Backend::Telegram(b) => b.read_state().await,
            Backend::Drive(b) => b.read_state().await,
        }
    }
    /// Replace the sync-state document.
    pub async fn write_state(&self, bytes: Vec<u8>) -> Result<(), String> {
        match self {
            Backend::Telegram(b) => b.write_state(bytes).await,
            Backend::Drive(b) => b.write_state(bytes).await,
        }
    }
}

#[derive(Serialize, Deserialize)]
struct ProviderCfg { provider: String }

pub(crate) fn data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(name))
}

pub(crate) fn set_provider(app: &AppHandle, provider: &str) -> Result<(), String> {
    let s = serde_json::to_vec(&ProviderCfg { provider: provider.into() }).map_err(|e| e.to_string())?;
    atomic_write(&data_file(app, PROVIDER_FILE)?, &s)
}

/// The connected provider; installs from before the chooser existed were Telegram.
fn provider(app: &AppHandle) -> Result<String, String> {
    match fs::read_to_string(data_file(app, PROVIDER_FILE)?) {
        Ok(s) => Ok(serde_json::from_str::<ProviderCfg>(&s).map_err(|e| e.to_string())?.provider),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("telegram".into()),
        Err(e) => Err(e.to_string()),
    }
}

/// `None` when no provider is connected.
fn load_backend(app: &AppHandle) -> Result<Option<(String, Backend)>, String> {
    match provider(app)?.as_str() {
        "telegram" => Ok(TgStore::load(app)?.map(|b| ("telegram".to_string(), Backend::Telegram(b)))),
        "gdrive" => Ok(GDrive::load(app)?.map(|b| ("gdrive".to_string(), Backend::Drive(b)))),
        other => Err(format!("Unknown storage provider: {other}")),
    }
}

// ─── persisted merge base ────────────────────────────────────────────────────

/// One note as known on the backend.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    /// Provider-specific handle for `get` / `delete`.
    pub id: String,
    pub hash: String,
    /// Unix seconds of the file's last modification on the uploading machine.
    #[serde(default)]
    pub updated: u64,
}

/// The sealed manifest (decrypted form).
#[derive(Serialize, Deserialize, Default)]
struct Manifest { v: u32, files: HashMap<String, Entry> }

#[derive(Serialize, Deserialize, Default)]
struct Index {
    /// What was in sync at the end of the last successful run (the merge base).
    #[serde(default)]
    entries: HashMap<String, String>,
    #[serde(default)]
    last_sync: Option<u64>,
}

fn load_index(app: &AppHandle) -> Result<Index, String> {
    match fs::read_to_string(data_file(app, INDEX_FILE)?) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Index::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save_index(app: &AppHandle, idx: &Index) -> Result<(), String> {
    let s = serde_json::to_vec(idx).map_err(|e| e.to_string())?;
    atomic_write(&data_file(app, INDEX_FILE)?, &s)
}

/// Forget the provider and merge base (credentials are removed by the provider module).
pub(crate) fn reset_local(app: &AppHandle) -> Result<(), String> {
    for f in [INDEX_FILE, PROVIDER_FILE] {
        let _ = fs::remove_file(data_file(app, f)?);
    }
    Ok(())
}

// ─── small helpers ───────────────────────────────────────────────────────────

pub(crate) fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

pub(crate) fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Random upload name; keeps titles and folders off the provider.
pub(crate) fn random_name() -> String {
    format!("{}.nqv", random_hex(16))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// All `.nqv` files under `root` as (relative path with `/`, absolute path).
pub(crate) fn collect(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, PathBuf)>) {
    if depth > MAX_DEPTH { return; }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let path = ent.path();
        let Ok(ft) = ent.file_type() else { continue };
        if ft.is_dir() {
            collect(root, &path, depth + 1, out);
        } else if ft.is_file() && name.to_ascii_lowercase().ends_with(".nqv") {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, path.clone()));
            }
        }
    }
}

// ─── sync state document ─────────────────────────────────────────────────────
// "NQS1" | u32 BE len | vault.json bytes | sealed vault database
// (backups from older versions hold a sealed per-note manifest instead)

fn pack_state(vault_json: &str, sealed: &[u8]) -> Vec<u8> {
    let vj = vault_json.as_bytes();
    let mut out = Vec::with_capacity(8 + vj.len() + sealed.len());
    out.extend_from_slice(STATE_MAGIC);
    out.extend_from_slice(&(vj.len() as u32).to_be_bytes());
    out.extend_from_slice(vj);
    out.extend_from_slice(sealed);
    out
}

fn unpack_state(b: &[u8]) -> Result<(String, Vec<u8>), String> {
    if b.len() < 8 || &b[..4] != STATE_MAGIC {
        return Err("Unrecognised backup format".into());
    }
    let n = u32::from_be_bytes([b[4], b[5], b[6], b[7]]) as usize;
    if b.len() < 8 + n { return Err("Backup is truncated".into()); }
    let vj = String::from_utf8(b[8..8 + n].to_vec()).map_err(|_| "Backup is corrupted".to_string())?;
    Ok((vj, b[8 + n..].to_vec()))
}

/// New device: install the key file from the backend's sync-state document.
/// The user then unlocks with the master password and runs a normal sync.
pub(crate) async fn bootstrap(app: &AppHandle, backend: &Backend) -> Result<(), String> {
    if vault::read_meta_json(app)?.is_some() {
        return Err("A vault already exists on this device".into());
    }
    let bytes = backend.read_state().await?.ok_or("No Notiq backup found")?;
    let (vault_json, _) = unpack_state(&bytes)
        .map_err(|_| "That isn't a Notiq backup (was it made by an older version? Sync once from your original device first)".to_string())?;
    vault::install_meta_json(app, &vault_json)
}

// ─── commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SyncStatus {
    configured: bool,
    /// "telegram" | "gdrive" when configured.
    provider: Option<String>,
    /// Human-readable target, e.g. "chat 123" or an email address.
    detail: Option<String>,
    last_sync: Option<u64>,
}

#[tauri::command]
pub fn sync_status(app: AppHandle) -> Result<SyncStatus, String> {
    let last_sync = load_index(&app)?.last_sync;
    let prov = provider(&app)?;
    let detail = match prov.as_str() {
        "telegram" => TgStore::detail(&app),
        "gdrive" => GDrive::detail(&app),
        _ => None,
    };
    Ok(SyncStatus { configured: detail.is_some(), provider: detail.as_ref().map(|_| prov), detail, last_sync })
}

#[tauri::command]
pub fn sync_disconnect(app: AppHandle) -> Result<(), String> {
    TgStore::clear(&app)?;
    GDrive::clear(&app)?;
    reset_local(&app)
}

#[derive(Serialize)]
pub struct FileState { rel: String, state: &'static str }

/// Per-note sync badge: "synced", "modified" (changed since last sync) or "new".
/// Names are encrypted, so while the vault is locked there is nothing to show.
#[tauri::command]
pub fn sync_state(app: AppHandle, state: State<'_, VaultState>, root: String) -> Result<Vec<FileState>, String> {
    if !sync_status(app.clone())?.configured { return Ok(vec![]); }
    state.set_root(PathBuf::from(root));
    let idx = load_index(&app)?;
    match state.with_db(|db, _, _, _| {
        let v = db
            .entries
            .values()
            .filter(|e| !e.deleted && !e.dir)
            .map(|e| FileState {
                rel: e.path.clone(),
                state: match idx.entries.get(&e.id) {
                    Some(h) if *h == e.hash() => "synced",
                    Some(_) => "modified",
                    None => "new",
                },
            })
            .collect::<Vec<_>>();
        Ok((v, false))
    }) {
        Err(e) if e == "VAULT_LOCKED" => Ok(vec![]),
        r => r,
    }
}

#[derive(Serialize, Default)]
pub struct SyncReport {
    /// Notes changed on this device that were pushed to the backup.
    uploaded: u32,
    /// Notes created/updated here from another device (so the UI can reload open tabs).
    downloaded: Vec<String>,
    conflicts: u32,
    skipped: u32,
    failed: Vec<String>,
}

/// What one merge pass decided (computed under the DB lock, used after it).
struct Pass {
    pulled: Vec<String>,
    conflicts: u32,
    /// Sealed sync-state document to publish, if the backup is out of date.
    push: Option<Vec<u8>>,
    prints: HashMap<String, String>,
    changed: u32,
    total: u32,
}

/// Two-way sync of the single vault database: download the backup, merge it into the
/// local database entry by entry, and publish the result if it differs from the backup.
/// Requires the vault to be unlocked (the database is sealed with its key).
#[tauri::command]
pub async fn sync_run(app: AppHandle, state: State<'_, VaultState>, root: String) -> Result<SyncReport, String> {
    // One sync at a time: auto-sync, "Sync now" and sync-before-lock would otherwise
    // race on the index and overwrite each other's work.
    static SYNC_LOCK: std::sync::OnceLock<tauri::async_runtime::Mutex<()>> = std::sync::OnceLock::new();
    let _guard = SYNC_LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(())).lock().await;

    let (_, backend) = load_backend(&app)?.ok_or("Storage isn't set up yet")?;
    state.with_unlocked(|_, _| Ok(()))?;
    state.set_root(PathBuf::from(root));
    let mut idx = load_index(&app)?;
    let mut rep = SyncReport::default();

    // A second device may publish while we merge; re-merge (a few times) rather than overwrite it.
    for attempt in 0..3 {
        // 1. The backup, as published.
        let remote_bytes = backend.read_state().await?;
        let remote_sha = remote_bytes.as_deref().map(sha_hex);
        let sealed = remote_bytes.as_deref().and_then(|b| unpack_state(b).ok()).map(|(_, s)| s);

        // 2. Backups made by older versions stored one blob per note plus a sealed manifest.
        let mut legacy: Vec<(String, Vec<u8>)> = vec![];
        let mut legacy_ids: Vec<String> = vec![];
        if let Some(s) = &sealed {
            let opened = state
                .with_unlocked(|k, id| vc::open(k, id, s).map_err(|e| e.to_string()))
                .map_err(|_| "This backup belongs to a different vault or is corrupted".to_string())?;
            if opened.0 != DB_EXT {
                let m: Manifest = serde_json::from_slice(&opened.1).map_err(|e| e.to_string())?;
                for (rel, e) in m.files {
                    legacy_ids.push(e.id.clone());
                    match backend.get(&e.id).await {
                        Ok(b) if sha_hex(&b) == e.hash => legacy.push((rel, b)),
                        Ok(_) => rep.failed.push(format!("{rel}: checksum mismatch, not imported")),
                        Err(err) => rep.failed.push(format!("{rel}: {err}")),
                    }
                }
            }
        }
        let is_legacy = !legacy_ids.is_empty();

        // 3. Merge into the local database.
        let base = idx.entries.clone();
        let sealed_ref = sealed.as_deref();
        let vault_json = vault::read_meta_json(&app)?.ok_or("No vault on this device")?;
        let pass = state.with_db(|db, _, key, id| {
            let before = db.fingerprints();
            let remote_db = match sealed_ref {
                Some(s) => vdb::Db::open(key, id, s)?,
                None => None,
            };
            let (merged, stats) = match &remote_db {
                Some(r) => vdb::merge(db, r, &base),
                None => {
                    let mut m = db.clone();
                    for (rel, bytes) in &legacy {
                        let Ok((ext, plain)) = vc::open(key, id, bytes) else { continue };
                        let Ok(text) = String::from_utf8(plain.to_vec()) else { continue };
                        if m.get(rel).is_none() { let _ = m.put(rel, &ext, &text); }
                    }
                    (m, vdb::MergeStats::default())
                }
            };
            let prints = merged.fingerprints();
            let pulled: Vec<String> = merged
                .entries
                .values()
                .filter(|e| !e.deleted && !e.dir && before.get(&e.id) != Some(&e.hash()))
                .map(|e| e.path.clone())
                .collect();
            let remote_prints = remote_db.as_ref().map(|r| r.fingerprints());
            let up_to_date = remote_prints.as_ref() == Some(&prints) && !is_legacy;
            let push = if up_to_date {
                None
            } else {
                Some(pack_state(&vault_json, &merged.seal(key, id)?))
            };
            let changed = prints.iter().filter(|(k, v)| base.get(*k) != Some(*v)).count() as u32;
            let total = merged.entries.values().filter(|e| !e.deleted && !e.dir).count() as u32;
            let dirty = prints != before;
            *db = merged;
            Ok((Pass { pulled, conflicts: stats.conflicts, push, prints, changed, total }, dirty))
        })?;

        // 4. Publish (unless someone else just did).
        if let Some(bytes) = pass.push {
            if bytes.len() as u64 > MAX_FILE {
                rep.failed.push("vault: the encrypted vault is larger than 19 MB, so it can't be backed up".into());
                return Ok(rep);
            }
            if attempt < 2 && backend.read_state().await?.as_deref().map(sha_hex) != remote_sha {
                continue; // changed under us; merge again
            }
            if let Err(e) = backend.write_state(bytes).await {
                rep.failed.push(format!("sync state: {e}"));
                return Ok(rep); // keep the old merge base; the next run redoes the work
            }
            for old in &legacy_ids { backend.delete(old).await; } // best effort: superseded blobs
            rep.uploaded = pass.changed;
        } else {
            rep.skipped = pass.total;
        }
        rep.downloaded = pass.pulled;
        rep.conflicts = pass.conflicts;
        idx.entries = pass.prints;
        idx.last_sync = Some(now_secs());
        save_index(&app, &idx)?;
        return Ok(rep);
    }
    rep.failed.push("another device kept changing the backup; will retry".into());
    Ok(rep)
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_document_round_trips() {
        let packed = pack_state("{\"v\":1}", &[1, 2, 3]);
        let (vj, sealed) = unpack_state(&packed).unwrap();
        assert_eq!(vj, "{\"v\":1}");
        assert_eq!(sealed, vec![1, 2, 3]);
        assert!(unpack_state(b"nope").is_err());
        assert!(unpack_state(b"NQS1\x00\x00\x00\xffxx").is_err());
    }

    #[test]
    fn random_names_are_unique_nqv_files() {
        let (a, b) = (random_name(), random_name());
        assert_ne!(a, b);
        assert!(a.ends_with(".nqv") && a.len() == 36);
    }
}
