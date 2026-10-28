//! Secure Vault — Tauri command layer over `vault_core`.
//!
//! The unlocked vault key lives only in this process's memory (`VaultState`)
//! and is zeroised on lock/drop. Notes are written to disk only as `.nqv`
//! ciphertext. Only `vault.json` (wrapped keys, no secrets in the clear)
//! is stored in the app-data directory.
//!
//! Error strings `NO_VAULT` and `VAULT_LOCKED` are stable codes the frontend
//! can match on; everything else is a human-readable message.

use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{Instant, SystemTime},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::vault_core::{self as vc, KdfParams, Throttle, VaultError, VaultKey, VaultMeta, VAULT_ID_LEN};
use crate::vault_db::{self as vdb, Db, ListItem};

const META_FILE: &str = "vault.json";
const NQV_EXT: &str = "nqv";

const ERR_NO_VAULT: &str = "NO_VAULT";
const ERR_LOCKED: &str = "VAULT_LOCKED";

struct Unlocked {
    key: VaultKey,
    vault_id: [u8; VAULT_ID_LEN],
}

/// The storage folder and the decrypted database (cached while unlocked).
#[derive(Default)]
struct Store {
    root: Option<PathBuf>,
    db: Option<Db>,
    /// Modification time of `vault.nqdb` when `db` was loaded/saved; a different time
    /// on disk means another process (e.g. a folder-sync tool) replaced it.
    stamp: Option<SystemTime>,
}

#[derive(Default)]
pub struct VaultState {
    key: Mutex<Option<Unlocked>>,
    throttle: Mutex<Throttle>,
    store: Mutex<Store>,
}

impl VaultState {
    fn guard(&self) -> MutexGuard<'_, Option<Unlocked>> {
        // A poisoned lock only means another thread panicked; the data is
        // still a valid Option, so keep going rather than wedging the vault.
        self.key.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn throttle(&self) -> MutexGuard<'_, Throttle> {
        self.throttle.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, key: VaultKey, vault_id: [u8; VAULT_ID_LEN]) {
        *self.guard() = Some(Unlocked { key, vault_id });
    }

    /// Runs `f` on the vault database (loaded on first use). `f` returns its result and
    /// whether it changed the DB; a changed DB is sealed and written back atomically
    /// before this returns. Lock order is always key, then store.
    pub(crate) fn with_db<T>(
        &self,
        f: impl FnOnce(&mut Db, &Path, &VaultKey, &[u8; VAULT_ID_LEN]) -> Result<(T, bool), String>,
    ) -> Result<T, String> {
        let kg = self.guard();
        let u = kg.as_ref().ok_or(ERR_LOCKED)?;
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let root = st.root.clone().ok_or("The vault folder isn't set yet")?;
        let on_disk = fs::metadata(vdb::db_path(&root)).and_then(|m| m.modified()).ok();
        if st.db.is_none() || st.stamp != on_disk {
            st.db = Some(vdb::load(&root, &u.key, &u.vault_id)?);
            st.stamp = on_disk;
        }
        let db = st.db.as_mut().expect("loaded above");
        let purged = db.purge_expired(vdb::now_ms()) > 0; // recycle-bin items older than 30 days
        let (out, dirty) = match f(db, &root, &u.key, &u.vault_id) {
            Ok(r) => r,
            Err(e) => { st.db = None; return Err(e); } // never keep a half-applied change in memory
        };
        let dirty = dirty || purged;
        if dirty {
            let saved = st.db.as_ref().expect("still loaded").seal(&u.key, &u.vault_id)
                .and_then(|bytes| vdb::save(&root, &bytes));
            if let Err(e) = saved { st.db = None; return Err(e); }
            st.stamp = fs::metadata(vdb::db_path(&root)).and_then(|m| m.modified()).ok();
        }
        Ok(out)
    }

    /// Records the folder that holds vault.nqdb; a different folder drops the cached DB.
    pub(crate) fn set_root(&self, root: PathBuf) {
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.root.as_deref() != Some(root.as_path()) {
            st.root = Some(root);
            st.db = None;
            st.stamp = None;
        }
    }

    fn clear_db(&self) {
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        st.db = None; // dropping zeroises the contents
        st.stamp = None;
    }
}

#[derive(Serialize)]
pub struct VaultStatus {
    exists: bool,
    unlocked: bool,
}

#[derive(Serialize)]
pub struct VaultFile {
    content: String,
    ext: String,
}

// ─── helpers ─────────────────────────────────────────────────────────────────

fn meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(META_FILE))
}

fn load_meta(app: &AppHandle) -> Result<Option<VaultMeta>, String> {
    match fs::read_to_string(meta_path(app)?) {
        Ok(s) => VaultMeta::from_json(&s).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn require_meta(app: &AppHandle) -> Result<VaultMeta, String> {
    load_meta(app)?.ok_or_else(|| ERR_NO_VAULT.to_string())
}

/// Write to a temp file in the same directory, fsync, then rename over the
/// target — a crash mid-save can never leave a half-written file.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let result = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(|e| e.to_string())
}

fn save_meta(app: &AppHandle, meta: &VaultMeta) -> Result<(), String> {
    atomic_write(&meta_path(app)?, meta.to_json().as_bytes())
}

fn check_nqv_path(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ok = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case(NQV_EXT))
        .unwrap_or(false);
    if !ok {
        return Err("Vault files must use the .nqv extension".into());
    }
    Ok(p)
}

/// Run CPU-heavy (Argon2) work off the main thread.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, vc::VaultError> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

/// Like `blocking`, but for operations that check a password / recovery key:
/// refuses while throttled, counts wrong credentials, and resets on success.
async fn guarded<T: Send + 'static>(
    state: &VaultState,
    f: impl FnOnce() -> Result<T, VaultError> + Send + 'static,
) -> Result<T, String> {
    if let Err(wait) = state.throttle().check(Instant::now()) {
        let secs = wait.as_secs() + 1; // round up so "0s" is never shown
        return Err(format!("Too many attempts. Try again in {secs}s"));
    }
    let result = tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?;
    match result {
        Ok(v) => {
            state.throttle().record_success();
            Ok(v)
        }
        Err(e) => {
            if matches!(e, VaultError::WrongPassword | VaultError::WrongRecoveryKey) {
                state.throttle().record_failure(Instant::now());
            }
            Err(e.to_string())
        }
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn vault_status(app: AppHandle, state: State<'_, VaultState>) -> Result<VaultStatus, String> {
    Ok(VaultStatus {
        exists: load_meta(&app)?.is_some(),
        unlocked: state.guard().is_some(),
    })
}

/// Creates the vault, unlocks it, and returns the recovery key. The recovery
/// key is shown to the user once and is NOT stored anywhere.
#[tauri::command]
pub async fn vault_create(
    app: AppHandle,
    state: State<'_, VaultState>,
    password: String,
) -> Result<String, String> {
    if load_meta(&app)?.is_some() {
        return Err("A vault already exists".into());
    }
    let password = Zeroizing::new(password);
    let (meta, key, recovery) = blocking(move || vc::create_vault(&password, KdfParams::default())).await?;
    save_meta(&app, &meta)?;
    state.set(key, meta.vault_id_bytes().map_err(|e| e.to_string())?);
    Ok(recovery)
}

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    state: State<'_, VaultState>,
    password: String,
) -> Result<(), String> {
    let meta = require_meta(&app)?;
    let m = meta.clone();
    let password = Zeroizing::new(password);
    let key = guarded(&state, move || vc::unlock_with_password(&m, &password)).await?;
    state.set(key, meta.vault_id_bytes().map_err(|e| e.to_string())?);
    Ok(())
}

/// Forgot-password path: unlock with the recovery key and set a new password.
#[tauri::command]
pub async fn vault_unlock_with_recovery(
    app: AppHandle,
    state: State<'_, VaultState>,
    recovery_key: String,
    new_password: String,
) -> Result<(), String> {
    let meta = require_meta(&app)?;
    let m = meta.clone();
    let recovery_key = Zeroizing::new(recovery_key);
    let new_password = Zeroizing::new(new_password);
    let (key, new_meta) = guarded(&state, move || {
        let key = vc::unlock_with_recovery(&m, &recovery_key)?;
        let new_meta = vc::rewrap_password(&m, &key, &new_password)?;
        Ok((key, new_meta))
    })
    .await?;
    save_meta(&app, &new_meta)?;
    state.set(key, new_meta.vault_id_bytes().map_err(|e| e.to_string())?);
    Ok(())
}

#[tauri::command]
pub async fn vault_change_password(
    app: AppHandle,
    state: State<'_, VaultState>,
    old_password: String,
    new_password: String,
) -> Result<(), String> {
    let meta = require_meta(&app)?;
    let m = meta.clone();
    let old_password = Zeroizing::new(old_password);
    let new_password = Zeroizing::new(new_password);
    let (key, new_meta) = guarded(&state, move || {
        let key = vc::unlock_with_password(&m, &old_password)?;
        let new_meta = vc::rewrap_password(&m, &key, &new_password)?;
        Ok((key, new_meta))
    })
    .await?;
    save_meta(&app, &new_meta)?;
    state.set(key, new_meta.vault_id_bytes().map_err(|e| e.to_string())?);
    Ok(())
}

/// Drops the key from memory (zeroised on drop).
#[tauri::command]
pub fn vault_lock(state: State<'_, VaultState>) {
    *state.guard() = None;
    state.clear_db();
}

// ─── the vault database (single encrypted file) ──────────────────────────────
// Notes are addressed by their "virtual path" `<root>/<rel>.nqv`; nothing but
// `<root>/vault.nqdb` exists on disk.

/// Tells the backend which folder holds `vault.nqdb`. Works while locked.
#[tauri::command]
pub fn vault_set_root(state: State<'_, VaultState>, root: String) -> Result<(), String> {
    state.set_root(PathBuf::from(root));
    Ok(())
}

/// Encrypts `content` into the vault database under `path` (must end in `.nqv`).
/// `ext` is the original file type, e.g. "md".
#[tauri::command]
pub fn vault_write_file(state: State<'_, VaultState>, path: String, content: String, ext: String) -> Result<(), String> {
    check_nqv_path(&path)?;
    if ext.len() > 16 || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("Invalid file type".into());
    }
    let content = Zeroizing::new(content);
    state.with_db(|db, root, _, _| {
        db.put(&vdb::rel_from_full(root, &path)?, &ext, &content)?;
        Ok(((), true))
    })
}

/// Decrypts one note from the vault database.
#[tauri::command]
pub fn vault_read_file(state: State<'_, VaultState>, path: String) -> Result<VaultFile, String> {
    check_nqv_path(&path)?;
    state.with_db(|db, root, _, _| {
        let rel = vdb::rel_from_full(root, &path)?;
        let e = db.get(&rel).ok_or("This note no longer exists in the vault")?;
        Ok((VaultFile { content: e.content.clone(), ext: e.ext.clone() }, false))
    })
}

#[tauri::command]
pub fn vault_list(state: State<'_, VaultState>) -> Result<Vec<ListItem>, String> {
    state.with_db(|db, _, _, _| Ok((db.list(), false)))
}

#[tauri::command]
pub fn vault_mkdir(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.mkdir(&vdb::rel_from_full(root, &path)?)?;
        Ok(((), true))
    })
}

/// Recycle bin contents (trashed notes and folders, with rel paths).
#[tauri::command]
pub fn vault_list_trash(state: State<'_, VaultState>) -> Result<Vec<ListItem>, String> {
    state.with_db(|db, _, _, _| Ok((db.list_trash(), false)))
}

/// Moves a note, or a folder with everything in it, to the recycle bin.
#[tauri::command]
pub fn vault_trash(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.trash(&vdb::rel_from_full(root, &path)?)?;
        Ok(((), true))
    })
}

#[tauri::command]
pub fn vault_restore(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.restore(&vdb::rel_from_full(root, &path)?)?;
        Ok(((), true))
    })
}

/// Permanently deletes an item that is in the recycle bin.
#[tauri::command]
pub fn vault_purge(state: State<'_, VaultState>, path: String) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.purge(&vdb::rel_from_full(root, &path)?)?;
        Ok(((), true))
    })
}

#[tauri::command]
pub fn vault_empty_trash(state: State<'_, VaultState>) -> Result<(), String> {
    state.with_db(|db, _, _, _| {
        let n = db.empty_trash();
        Ok(((), n > 0))
    })
}

#[tauri::command]
pub fn vault_set_tags(state: State<'_, VaultState>, path: String, tags: Vec<String>) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.set_tags(&vdb::rel_from_full(root, &path)?, tags)?;
        Ok(((), true))
    })
}

#[tauri::command]
pub fn vault_set_starred(state: State<'_, VaultState>, path: String, starred: bool) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.set_starred(&vdb::rel_from_full(root, &path)?, starred)?;
        Ok(((), true))
    })
}

/// Copies a note to "<name> (copy).nqv"; returns the new full virtual path.
#[tauri::command]
pub fn vault_duplicate(state: State<'_, VaultState>, path: String) -> Result<String, String> {
    state.with_db(|db, root, _, _| {
        let rel = db.duplicate(&vdb::rel_from_full(root, &path)?)?;
        let base = root.to_string_lossy();
        Ok((format!("{}/{}", base.trim_end_matches(['/', '\\']), rel), true))
    })
}

#[tauri::command]
pub fn vault_rename(state: State<'_, VaultState>, from: String, to: String) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.rename(&vdb::rel_from_full(root, &from)?, &vdb::rel_from_full(root, &to)?)?;
        Ok(((), true))
    })
}

// ─── legacy per-note `.nqv` files ────────────────────────────────────────────

const MAX_DEPTH: usize = 6;

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

fn legacy_files(root: &Path) -> Vec<(String, PathBuf)> {
    let mut v = vec![];
    collect(root, root, 0, &mut v);
    v.sort();
    v
}

#[tauri::command]
pub fn vault_legacy_count(state: State<'_, VaultState>) -> Result<u32, String> {
    let st = state.store.lock().unwrap_or_else(|e| e.into_inner());
    let root = st.root.clone().ok_or("The vault folder isn't set yet")?;
    Ok(legacy_files(&root).len() as u32)
}

/// Copies every old `.nqv` file under the root into the database (originals are kept).
/// A note whose path already exists with different content is imported beside it.
#[tauri::command]
pub fn vault_import_legacy(state: State<'_, VaultState>) -> Result<u32, String> {
    state.with_db(|db, root, key, id| {
        let mut n = 0;
        for (rel, path) in legacy_files(root) {
            let Ok(data) = fs::read(&path) else { continue };
            let Ok((ext, plain)) = vc::open(key, id, &data) else { continue };
            let Ok(text) = String::from_utf8(plain.to_vec()) else { continue };
            let target = match db.get(&rel) {
                Some(e) if e.content == text && e.ext == ext => continue,
                Some(_) => format!("{} (imported).nqv", rel.trim_end_matches(".nqv")),
                None => rel,
            };
            db.put(&target, &ext, &text)?;
            n += 1;
        }
        db.legacy_imported = true;
        Ok((n, true))
    })
}

/// Deletes the old per-note files, but only those whose exact content is already in the database.
#[tauri::command]
pub fn vault_legacy_cleanup(state: State<'_, VaultState>) -> Result<u32, String> {
    state.with_db(|db, root, key, id| {
        let mut n = 0;
        for (rel, path) in legacy_files(root) {
            let Ok(data) = fs::read(&path) else { continue };
            let Ok((ext, plain)) = vc::open(key, id, &data) else { continue };
            let safe = db.entries.values().any(|e| !e.deleted && !e.dir && e.ext == ext && e.content.as_bytes() == plain.as_slice() && (e.path == rel || e.path.starts_with(&format!("{} (imported", rel.trim_end_matches(".nqv")))));
            if safe && fs::remove_file(&path).is_ok() { n += 1; }
        }
        Ok((n, false))
    })
}
