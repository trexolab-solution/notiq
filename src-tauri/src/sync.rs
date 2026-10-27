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
use zeroize::Zeroizing;

use crate::gdrive::GDrive;
use crate::telegram::TgStore;
use crate::vault::{self, atomic_write, VaultState};
use crate::vault_core as vc;

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
    /// Store a blob under a random name; returns a provider-specific id.
    pub async fn put(&self, bytes: Vec<u8>) -> Result<String, String> {
        match self {
            Backend::Telegram(b) => b.put(bytes).await,
            Backend::Drive(b) => b.put(bytes).await,
        }
    }
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
    files: HashMap<String, Entry>,
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

fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A manifest path must be a plain relative `.nqv` path — never `..`, never absolute.
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.to_ascii_lowercase().ends_with(".nqv")
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.contains(':')
        && rel.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// `<dir>/<stem> (conflict <ts>).nqv` next to the original.
fn conflict_rel(rel: &str, ts: u64) -> String {
    let stem = rel
        .strip_suffix(".nqv")
        .or_else(|| rel.strip_suffix(".NQV"))
        .unwrap_or(rel);
    format!("{stem} (conflict {ts}).nqv")
}

/// All `.nqv` files under `root` as (relative path with `/`, absolute path).
fn collect(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, PathBuf)>) {
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
// "NQS1" | u32 BE len | vault.json bytes | sealed manifest

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

// ─── merge planning (pure, unit-tested) ──────────────────────────────────────

#[derive(Debug, Clone)]
struct LocalFile { rel: String, hash: String, updated: u64 }

#[derive(Debug, PartialEq)]
enum Action {
    InSync(String),
    Upload(String),
    Download(String),
    /// Both sides changed; local is newer → keep local, save remote as a conflict copy.
    ConflictKeepLocal(String),
    /// Both sides changed; remote is newer → take remote, save local as a conflict copy.
    ConflictKeepRemote(String),
}

/// Three-way decision per note. `base` is what was in sync after the last run.
fn plan(local: &[LocalFile], remote: &HashMap<String, Entry>, base: &HashMap<String, Entry>) -> Vec<Action> {
    let l: HashMap<&str, &LocalFile> = local.iter().map(|f| (f.rel.as_str(), f)).collect();
    let mut rels: Vec<&str> = l.keys().copied().chain(remote.keys().map(|s| s.as_str())).collect();
    rels.sort_unstable();
    rels.dedup();
    rels.into_iter()
        .filter_map(|rel| match (l.get(rel), remote.get(rel)) {
            (Some(_), None) => Some(Action::Upload(rel.into())),
            (None, Some(_)) => Some(Action::Download(rel.into())),
            (Some(lf), Some(re)) => Some(if lf.hash == re.hash {
                Action::InSync(rel.into())
            } else {
                let b = base.get(rel).map(|e| e.hash.as_str());
                if b == Some(re.hash.as_str()) {
                    Action::Upload(rel.into()) // only we changed
                } else if b == Some(lf.hash.as_str()) {
                    Action::Download(rel.into()) // only they changed
                } else if lf.updated >= re.updated {
                    Action::ConflictKeepLocal(rel.into())
                } else {
                    Action::ConflictKeepRemote(rel.into())
                }
            }),
            (None, None) => None,
        })
        .collect()
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

/// Per-file sync badge: "synced", "modified" (changed since last sync) or "new".
#[tauri::command]
pub fn sync_state(app: AppHandle, root: String) -> Result<Vec<FileState>, String> {
    if !sync_status(app.clone())?.configured { return Ok(vec![]); }
    let idx = load_index(&app)?;
    let root = PathBuf::from(root);
    let mut files = vec![];
    collect(&root, &root, 0, &mut files);
    Ok(files
        .into_iter()
        .map(|(rel, path)| {
            let state = match (idx.files.get(&rel), fs::read(&path)) {
                (Some(e), Ok(b)) if e.hash == sha_hex(&b) => "synced",
                (Some(_), _) => "modified",
                (None, _) => "new",
            };
            FileState { rel, state }
        })
        .collect())
}

#[derive(Serialize, Default)]
pub struct SyncReport {
    uploaded: u32,
    /// Relative paths replaced/created locally (so the UI can reload open tabs).
    downloaded: Vec<String>,
    conflicts: u32,
    skipped: u32,
    failed: Vec<String>,
}

/// Two-way sync: pull what changed elsewhere, push what changed here.
/// Requires the vault to be unlocked (the manifest is sealed with its key).
#[tauri::command]
pub async fn sync_run(app: AppHandle, state: State<'_, VaultState>, root: String) -> Result<SyncReport, String> {
    // One sync at a time: auto-sync, "Sync now" and sync-before-lock would otherwise
    // race on the index and overwrite each other's manifest.
    static SYNC_LOCK: std::sync::OnceLock<tauri::async_runtime::Mutex<()>> = std::sync::OnceLock::new();
    let _guard = SYNC_LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(())).lock().await;

    let (_, backend) = load_backend(&app)?.ok_or("Storage isn't set up yet")?;
    state.with_unlocked(|_, _| Ok(()))?;

    let root = PathBuf::from(root);
    let mut idx = load_index(&app)?;
    let mut rep = SyncReport::default();

    // 1. Remote state (manifest sealed with the vault key).
    let mut need_state_upload = false;
    let mut remote: HashMap<String, Entry> = HashMap::new();
    match backend.read_state().await? {
        Some(bytes) => match unpack_state(&bytes) {
            Ok((_vault_json, sealed)) => {
                let (_ext, plain): (String, Zeroizing<Vec<u8>>) = state
                    .with_unlocked(|k, id| vc::open(k, id, &sealed).map_err(|e| e.to_string()))
                    .map_err(|_| "This backup belongs to a different vault or is corrupted".to_string())?;
                let m: Manifest = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
                remote = m.files;
            }
            // Unknown content: replace it with a proper state document.
            Err(_) => need_state_upload = true,
        },
        None => need_state_upload = true,
    }

    // 2. Local files.
    let mut found = vec![];
    collect(&root, &root, 0, &mut found);
    found.sort();
    let mut locals = vec![];
    for (rel, path) in found {
        match fs::read(&path) {
            Ok(b) if b.len() as u64 > MAX_FILE => rep.failed.push(format!("{rel}: larger than 19 MB")),
            Ok(b) => locals.push(LocalFile { rel, hash: sha_hex(&b), updated: mtime_secs(&path) }),
            Err(e) => rep.failed.push(format!("{rel}: {e}")),
        }
    }
    let local_map: HashMap<String, LocalFile> = locals.iter().cloned().map(|f| (f.rel.clone(), f)).collect();

    // 3. Execute the plan.
    let mut manifest_changed = false;
    let ts = now_secs();
    // Blobs replaced by this run: deleted only once the new manifest is published,
    // otherwise other devices would be left pointing at a deleted blob.
    let mut stale: Vec<String> = vec![];
    let mut fresh: Vec<String> = vec![]; // blobs uploaded by this run
    let mut failed_rels: Vec<String> = vec![];
    for action in plan(&locals, &remote, &idx.files) {
        let (rel, upload, download, conflict) = match action {
            Action::InSync(_) => { rep.skipped += 1; continue; }
            Action::Upload(r) => (r, true, false, false),
            Action::ConflictKeepLocal(r) => (r, true, false, true),
            Action::Download(r) => (r, false, true, false),
            Action::ConflictKeepRemote(r) => (r, false, true, true),
        };
        let result: Result<(), String> = async {
            if !safe_rel(&rel) { return Err("unsafe path skipped".into()); }
            let target = root.join(&rel);
            if upload {
                if conflict {
                    // Keep the other device's version beside ours before replacing it remotely.
                    let r = remote.get(&rel).ok_or("missing remote entry")?;
                    let bytes = backend.get(&r.id).await?;
                    if sha_hex(&bytes) == r.hash {
                        atomic_write(&root.join(conflict_rel(&rel, ts)), &bytes)?;
                        rep.conflicts += 1;
                    }
                }
                let lf = local_map.get(&rel).ok_or("local file vanished")?;
                let bytes = fs::read(&target).map_err(|e| e.to_string())?;
                if sha_hex(&bytes) != lf.hash { return Err("changed while syncing, will retry".into()); }
                let id = backend.put(bytes).await?;
                if let Some(old) = remote.get(&rel) { stale.push(old.id.clone()); }
                fresh.push(id.clone());
                remote.insert(rel.clone(), Entry { id, hash: lf.hash.clone(), updated: lf.updated });
                rep.uploaded += 1;
                manifest_changed = true;
            } else if download {
                let r = remote.get(&rel).ok_or("missing remote entry")?.clone();
                let bytes = backend.get(&r.id).await?;
                if sha_hex(&bytes) != r.hash { return Err("checksum mismatch, not downloaded".into()); }
                if conflict && target.exists() {
                    fs::copy(&target, root.join(conflict_rel(&rel, ts))).map_err(|e| e.to_string())?;
                    rep.conflicts += 1;
                }
                atomic_write(&target, &bytes)?;
                rep.downloaded.push(rel.clone());
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            rep.failed.push(format!("{rel}: {e}"));
            failed_rels.push(rel);
        }
    }

    // 4. Publish the merged manifest (+ key file) as the new sync state.
    let mut published = true;
    if manifest_changed || need_state_upload {
        let manifest = Manifest { v: 2, files: remote.clone() };
        let sent: Result<(), String> = async {
            let plain = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
            // Fails if the vault locked mid-sync; nothing is recorded, so the next run retries.
            let sealed = state.with_unlocked(|k, id| vc::seal(k, id, "json", &plain).map_err(|e| e.to_string()))?;
            let vault_json = vault::read_meta_json(&app)?.ok_or("No vault on this device")?;
            backend.write_state(pack_state(&vault_json, &sealed)).await
        }
        .await;
        if let Err(e) = sent {
            published = false;
            rep.failed.push(format!("sync state: {e}"));
        }
    }
    if published {
        for id in &stale { backend.delete(id).await; }
    } else {
        // New blobs are orphaned (the manifest never pointed at them): best-effort cleanup.
        for id in &fresh { backend.delete(id).await; }
        return Ok(rep); // keep the old merge base; the next run redoes the work
    }

    // The merge base only advances for notes that actually synced; a failed note keeps
    // its old base so it isn't mistaken for "only the other side changed" next time.
    let mut base = remote;
    for rel in &failed_rels {
        match idx.files.get(rel) {
            Some(old) => { base.insert(rel.clone(), old.clone()); }
            None => { base.remove(rel); }
        }
    }
    idx.files = base;
    idx.last_sync = Some(now_secs());
    save_index(&app, &idx)?;
    Ok(rep)
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn e(hash: &str, updated: u64) -> Entry {
        Entry { id: "x".into(), hash: hash.into(), updated }
    }
    fn l(rel: &str, hash: &str, updated: u64) -> LocalFile {
        LocalFile { rel: rel.into(), hash: hash.into(), updated }
    }
    fn map(items: &[(&str, Entry)]) -> HashMap<String, Entry> {
        items.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn new_local_is_uploaded_new_remote_is_downloaded() {
        let a = plan(&[l("a.nqv", "h1", 1)], &map(&[("b.nqv", e("h2", 1))]), &HashMap::new());
        assert_eq!(a, vec![Action::Upload("a.nqv".into()), Action::Download("b.nqv".into())]);
    }

    #[test]
    fn identical_is_in_sync() {
        let a = plan(&[l("a.nqv", "h", 5)], &map(&[("a.nqv", e("h", 9))]), &HashMap::new());
        assert_eq!(a, vec![Action::InSync("a.nqv".into())]);
    }

    #[test]
    fn only_local_changed_uploads() {
        let base = map(&[("a.nqv", e("old", 1))]);
        let a = plan(&[l("a.nqv", "new", 5)], &map(&[("a.nqv", e("old", 1))]), &base);
        assert_eq!(a, vec![Action::Upload("a.nqv".into())]);
    }

    #[test]
    fn only_remote_changed_downloads() {
        let base = map(&[("a.nqv", e("old", 1))]);
        let a = plan(&[l("a.nqv", "old", 1)], &map(&[("a.nqv", e("new", 9))]), &base);
        assert_eq!(a, vec![Action::Download("a.nqv".into())]);
    }

    #[test]
    fn both_changed_newer_side_wins() {
        let base = map(&[("a.nqv", e("old", 1))]);
        let keep_local = plan(&[l("a.nqv", "x", 10)], &map(&[("a.nqv", e("y", 5))]), &base);
        assert_eq!(keep_local, vec![Action::ConflictKeepLocal("a.nqv".into())]);
        let keep_remote = plan(&[l("a.nqv", "x", 5)], &map(&[("a.nqv", e("y", 10))]), &base);
        assert_eq!(keep_remote, vec![Action::ConflictKeepRemote("a.nqv".into())]);
    }

    #[test]
    fn differing_without_a_base_is_a_conflict() {
        let a = plan(&[l("a.nqv", "x", 3)], &map(&[("a.nqv", e("y", 4))]), &HashMap::new());
        assert_eq!(a, vec![Action::ConflictKeepRemote("a.nqv".into())]);
    }

    #[test]
    fn locally_deleted_notes_come_back_never_deleted_remotely() {
        let base = map(&[("a.nqv", e("h", 1))]);
        let a = plan(&[], &map(&[("a.nqv", e("h", 1))]), &base);
        assert_eq!(a, vec![Action::Download("a.nqv".into())]);
    }

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
    fn rel_paths_are_validated_and_conflict_names_stay_beside_the_original() {
        assert!(safe_rel("SSH/server.nqv"));
        assert!(!safe_rel("../x.nqv") && !safe_rel("/abs.nqv") && !safe_rel("a\\b.nqv") && !safe_rel("a.txt"));
        assert_eq!(conflict_rel("SSH/server.nqv", 7), "SSH/server (conflict 7).nqv");
    }

    #[test]
    fn random_names_are_unique_nqv_files() {
        let (a, b) = (random_name(), random_name());
        assert_ne!(a, b);
        assert!(a.ends_with(".nqv") && a.len() == 36);
    }
}
