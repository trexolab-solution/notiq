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
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    time::{Instant, SystemTime},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroizing;

use crate::vault_core::{self as vc, KdfParams, Throttle, VaultError, VaultKey, VaultMeta, VAULT_ID_LEN};
use crate::vault_db::{self as vdb, AttachmentMeta, Db, ListItem, RevisionMeta};

const META_FILE: &str = "vault.json";
/// 0.9.0 sync: the `vault.json` a synced password change replaced (for `PASSWORD_CHANGED_ELSEWHERE`).
const PREV_META_FILE: &str = "vault.prev.json";
/// 0.9.1: wrong passwords / recovery keys entered since the last successful unlock.
const ATTEMPTS_FILE: &str = "vault-attempts.json";
const NQV_EXT: &str = "nqv";

const ERR_NO_VAULT: &str = "NO_VAULT";
pub(crate) const ERR_LOCKED: &str = "VAULT_LOCKED";

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
    /// This installation's sync device id (`vault_hlc::DEVICE_FILE` in the app-data folder);
    /// given to every loaded DB before it can change anything.
    device: Option<String>,
}

/// Called after a user change to the vault was saved (0.9.0 sync schedules an upload).
pub(crate) type ChangeHook = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub struct VaultState {
    key: Mutex<Option<Unlocked>>,
    throttle: Mutex<Throttle>,
    store: Mutex<Store>,
    /// 0.9.0 sync: counts saved changes made outside sync, and the hook told about them.
    change_seq: AtomicU64,
    change_hook: OnceLock<ChangeHook>,
    /// 0.9.1: failed attempts found at the last successful unlock, until the UI takes them.
    attempts_notice: Mutex<Option<FailedAttempts>>,
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

    // 0.7.0 hello: the Windows Hello unlock installs a key it unwrapped (and verified) itself,
    // exactly like a successful password unlock.
    pub(crate) fn is_unlocked(&self) -> bool {
        self.guard().is_some()
    }

    pub(crate) fn install_key(&self, key: VaultKey, vault_id: [u8; VAULT_ID_LEN]) {
        self.set(key, vault_id);
    }

    /// Runs `f` on the vault database (loaded on first use). `f` returns its result and
    /// whether it changed the DB; a changed DB is sealed and written back atomically
    /// before this returns. Lock order is always key, then store.
    pub(crate) fn with_db<T>(
        &self,
        f: impl FnOnce(&mut Db, &Path, &VaultKey, &[u8; VAULT_ID_LEN]) -> Result<(T, bool), String>,
    ) -> Result<T, String> {
        let (out, dirty, restamped) = self.with_db_inner(f)?;
        if dirty || restamped { self.local_change(); }
        Ok(out)
    }

    /// Like [`with_db`](Self::with_db) for the sync engine's own merges: saved the same way, but
    /// not counted as a local change (that would schedule another upload of itself). Re-stamping a
    /// just-restored database on load still is one: it has to reach the other devices.
    pub(crate) fn with_db_quiet<T>(
        &self,
        f: impl FnOnce(&mut Db, &Path, &VaultKey, &[u8; VAULT_ID_LEN]) -> Result<(T, bool), String>,
    ) -> Result<T, String> {
        let (out, _, restamped) = self.with_db_inner(f)?;
        if restamped { self.local_change(); }
        Ok(out)
    }

    /// Counts a saved local change and tells the hook. Call after the locks are released: the
    /// hook takes the sync manager's own locks.
    fn local_change(&self) {
        self.change_seq.fetch_add(1, Ordering::SeqCst);
        if let Some(h) = self.change_hook.get() { h(); }
    }

    pub(crate) fn change_seq(&self) -> u64 {
        self.change_seq.load(Ordering::SeqCst)
    }

    pub(crate) fn set_change_hook(&self, hook: ChangeHook) {
        let _ = self.change_hook.set(hook);
    }

    /// A copy of the unlocked key (zeroised on drop) for one sync cycle.
    pub(crate) fn key_copy(&self) -> Option<(VaultKey, [u8; VAULT_ID_LEN])> {
        self.guard().as_ref().map(|u| (u.key.clone(), u.vault_id))
    }

    /// This installation's sync device id, once `ensure_device` ran.
    pub(crate) fn device_id(&self) -> Option<String> {
        self.store.lock().unwrap_or_else(|e| e.into_inner()).device.clone()
    }

    fn with_db_inner<T>(
        &self,
        f: impl FnOnce(&mut Db, &Path, &VaultKey, &[u8; VAULT_ID_LEN]) -> Result<(T, bool), String>,
    ) -> Result<(T, bool, bool), String> {
        let kg = self.guard();
        let u = kg.as_ref().ok_or(ERR_LOCKED)?;
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        let root = st.root.clone().ok_or("The vault folder isn't set yet")?;
        let on_disk = fs::metadata(vdb::db_path(&root)).and_then(|m| m.modified()).ok();
        let loaded = st.db.is_none() || st.stamp != on_disk;
        if loaded {
            st.db = Some(vdb::load(&root, &u.key, &u.vault_id)?);
            st.stamp = on_disk;
        }
        // Normally set by vault_set_root; a session-only id keeps stamps well-formed otherwise.
        let device = st.device.get_or_insert_with(crate::vault_hlc::new_device_id).clone();
        let db = st.db.as_mut().expect("loaded above");
        if db.device.is_empty() { db.device = device; }
        // Just restored from a backup: the restore is a new change, so the synced copy's later
        // deletions can't remove the restored entries again (Db::restamp_restored).
        let marker = vdb::restored_marker_path(&root);
        let restore = loaded && marker.exists();
        let restamped = restore && db.restamp_restored() > 0;
        let purged = db.purge_expired(vdb::now_ms()) > 0; // recycle-bin items older than 30 days
        let (out, dirty) = match f(db, &root, &u.key, &u.vault_id) {
            Ok(r) => r,
            Err(e) => { st.db = None; return Err(e); } // never keep a half-applied change in memory
        };
        let dirty = dirty || purged || restamped;
        if dirty {
            // save_db keeps a one-time vault.nqdb.v{N}.bak when this save upgrades an older format.
            let saved = vdb::save_db(&root, st.db.as_mut().expect("still loaded"), &u.key, &u.vault_id);
            if let Err(e) = saved { st.db = None; return Err(e); }
            st.stamp = fs::metadata(vdb::db_path(&root)).and_then(|m| m.modified()).ok();
        }
        if restore {
            // Only once the re-stamped database is on disk; a failed save above re-stamps next time.
            let _ = fs::remove_file(&marker);
        }
        Ok((out, dirty, restamped))
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

    /// Loads (or creates) this installation's device id from `dir` (the app-data folder), once.
    pub(crate) fn ensure_device(&self, dir: &Path) {
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        if st.device.is_some() { return; }
        match crate::vault_hlc::load_or_create_device(dir) {
            Ok(id) => st.device = Some(id),
            Err(e) => eprintln!("[vault] couldn't store the sync device id ({e}); using a session-only id"),
        }
    }

    /// The folder that holds vault.nqdb, once known.
    pub(crate) fn root(&self) -> Option<PathBuf> {
        self.store.lock().unwrap_or_else(|e| e.into_inner()).root.clone()
    }

    /// Drops the key and the cached database (used when the vault files are swapped out).
    pub(crate) fn lock_all(&self) {
        *self.guard() = None;
        self.clear_db();
    }

    fn clear_db(&self) {
        let mut st = self.store.lock().unwrap_or_else(|e| e.into_inner());
        st.db = None; // dropping zeroises the contents
        st.stamp = None;
    }
}

/// Emitted to every window whenever the vault is unlocked or locked (`{unlocked, source}`), so a
/// window other than the one that did it (main ⇄ autofill prompt) can follow. `source` is the label
/// of the window whose command changed the state; that window already knows and ignores the event.
pub const STATE_EVENT: &str = "vault:state-changed";

pub fn state_payload(unlocked: bool, source: &str) -> serde_json::Value {
    serde_json::json!({ "unlocked": unlocked, "source": source })
}

pub(crate) fn notify_state(app: &AppHandle, unlocked: bool, source: &str) {
    let _ = app.emit(STATE_EVENT, state_payload(unlocked, source));
    crate::capture_shield::refresh(app);
}

/// 0.9.1: wrong master passwords / recovery keys entered since the last successful unlock
/// (`vault-attempts.json` in the app-data folder; removed by the next successful unlock).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailedAttempts {
    pub count: u32,
    /// Unix ms of the most recent one.
    pub last_ms: u64,
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

pub(crate) fn meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(META_FILE))
}

pub(crate) fn load_meta(app: &AppHandle) -> Result<Option<VaultMeta>, String> {
    match fs::read_to_string(meta_path(app)?) {
        Ok(s) => VaultMeta::from_json(&s).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn require_meta(app: &AppHandle) -> Result<VaultMeta, String> {
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

pub(crate) fn save_meta(app: &AppHandle, meta: &VaultMeta) -> Result<(), String> {
    atomic_write(&meta_path(app)?, meta.to_json().as_bytes())
}

fn prev_meta_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(meta_path(app)?.with_file_name(PREV_META_FILE))
}

/// The `vault.json` that a synced password change replaced, if any.
pub(crate) fn load_prev_meta(app: &AppHandle) -> Option<VaultMeta> {
    let s = fs::read_to_string(prev_meta_path(app).ok()?).ok()?;
    VaultMeta::from_json(&s).ok()
}

/// 0.9.0 sync: installs a newer `vault.json` from another device (same key, new password wrap),
/// keeping the current one as `vault.prev.json`.
pub(crate) fn adopt_meta(app: &AppHandle, meta: &VaultMeta) -> Result<(), String> {
    if let Some(cur) = load_meta(app)? {
        atomic_write(&prev_meta_path(app)?, cur.to_json().as_bytes())?;
    }
    save_meta(app, meta)
}

/// A password change / recovery reset made on this device now (0.9.0 sync: between two concurrent
/// changes on different devices, the later one wins).
fn stamped_change(state: &VaultState, mut meta: VaultMeta) -> VaultMeta {
    meta.stamp_change(vdb::now_ms(), state.device_id().as_deref());
    meta
}

/// Forgets `vault.prev.json` (the password was changed here, or another vault was installed).
pub(crate) fn clear_prev_meta(app: &AppHandle) {
    if let Ok(p) = prev_meta_path(app) { let _ = fs::remove_file(p); }
}

// ─── 0.9.1: failed-attempt notice ─────────────────────────────────────────────

fn attempts_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(meta_path(app)?.with_file_name(ATTEMPTS_FILE))
}

fn read_attempts(path: &Path) -> FailedAttempts {
    fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Adds one failed attempt made at `now_ms`.
fn bump_attempts(path: &Path, now_ms: u64) -> Result<(), String> {
    let prev = read_attempts(path);
    let next = FailedAttempts { count: prev.count.saturating_add(1), last_ms: now_ms.max(prev.last_ms) };
    atomic_write(path, serde_json::to_string(&next).map_err(|e| e.to_string())?.as_bytes())
}

/// Reads and removes the record; `None` when there were no failed attempts.
fn take_attempts(path: &Path) -> Option<FailedAttempts> {
    let a = read_attempts(path);
    let _ = fs::remove_file(path);
    (a.count > 0).then_some(a)
}

/// A wrong password / recovery key from `guarded` (not a throttle refusal or another error).
fn is_wrong_credential(err: &str) -> bool {
    err == VaultError::WrongPassword.to_string() || err == VaultError::WrongRecoveryKey.to_string()
}

/// Counts a failed unlock attempt (best effort: never turns the unlock error into another one).
fn note_failed_unlock(app: &AppHandle, err: &str) {
    if !is_wrong_credential(err) { return; }
    if let Err(e) = attempts_path(app).and_then(|p| bump_attempts(&p, vdb::now_ms())) {
        eprintln!("[vault] couldn't record a failed unlock attempt: {e}");
    }
}

/// After any successful unlock: resets the count and keeps it for the one-time notice.
pub(crate) fn note_successful_unlock(app: &AppHandle, state: &VaultState) {
    let found = attempts_path(app).ok().and_then(|p| take_attempts(&p));
    if found.is_some() {
        *state.attempts_notice.lock().unwrap_or_else(|e| e.into_inner()) = found;
    }
}

/// The failed attempts found at the last successful unlock, once (the next call returns `None`).
#[tauri::command]
pub fn vault_take_failed_attempts(state: State<'_, VaultState>) -> Option<FailedAttempts> {
    state.attempts_notice.lock().unwrap_or_else(|e| e.into_inner()).take()
}

// ─── 0.9.1: KDF auto-upgrade ─────────────────────────────────────────────────

/// Re-derives the password wrap with today's Argon2 settings after a password unlock of a vault
/// created with weaker ones. Runs in the background; a failure is logged and changes nothing.
fn spawn_kdf_upgrade(app: AppHandle, meta: VaultMeta, key: VaultKey, password: Arc<Zeroizing<String>>) {
    tauri::async_runtime::spawn(async move {
        let from = meta.clone();
        let target = KdfParams::default();
        let upgraded = blocking(move || vc::upgrade_kdf(&meta, &key, &password, &target)).await;
        let saved = upgraded.and_then(|mut up| {
            // Only over the vault.json that was unlocked: a password change or a synced meta that
            // landed meanwhile is newer, and the next unlock upgrades that one instead.
            if load_meta(&app)?.as_ref() != Some(&from) {
                return Ok(false);
            }
            // A stamped change so Vault Sync uploads it, but with the lowest stamp after the meta it
            // replaces: a real password change / recovery reset made on another device is always
            // later and wins over this upgrade (engine::remote_meta_wins).
            up.stamp_change(0, app.state::<VaultState>().device_id().as_deref());
            save_meta(&app, &up)?;
            Ok(true)
        });
        match saved {
            Ok(true) => crate::sync::commands::on_local_meta_changed(&app),
            Ok(false) => eprintln!("[vault] KDF upgrade skipped: vault.json changed meanwhile"),
            Err(e) => eprintln!("[vault] KDF upgrade failed (the vault stays unlocked as usual): {e}"),
        }
    });
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
pub(crate) async fn guarded<T: Send + 'static>(
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
    window: tauri::Window,
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
    notify_state(&app, true, window.label());
    Ok(recovery)
}

#[tauri::command]
pub async fn vault_unlock(
    app: AppHandle,
    window: tauri::Window,
    state: State<'_, VaultState>,
    password: String,
) -> Result<(), String> {
    let meta = require_meta(&app)?;
    let m = meta.clone();
    let prev = load_prev_meta(&app);
    let password = Arc::new(Zeroizing::new(password));
    let pw = Arc::clone(&password);
    // A password another device replaced fails with PASSWORD_CHANGED_ELSEWHERE (0.9.0 sync).
    let key = guarded(&state, move || vc::unlock_with_password_or_previous(&m, prev.as_ref(), &pw))
        .await
        .inspect_err(|e| note_failed_unlock(&app, e))?;
    let vault_id = meta.vault_id_bytes().map_err(|e| e.to_string())?;
    if vc::kdf_needs_upgrade(&meta, &KdfParams::default()) {
        spawn_kdf_upgrade(app.clone(), meta, key.clone(), password);
    }
    state.set(key, vault_id);
    note_successful_unlock(&app, &state);
    notify_state(&app, true, window.label());
    crate::sync::commands::on_unlocked(&app);
    Ok(())
}

/// Forgot-password path: unlock with the recovery key and set a new password.
#[tauri::command]
pub async fn vault_unlock_with_recovery(
    app: AppHandle,
    window: tauri::Window,
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
    .await
    .inspect_err(|e| note_failed_unlock(&app, e))?;
    let new_meta = stamped_change(&state, new_meta);
    save_meta(&app, &new_meta)?;
    state.set(key, new_meta.vault_id_bytes().map_err(|e| e.to_string())?);
    note_successful_unlock(&app, &state);
    notify_state(&app, true, window.label());
    crate::sync::commands::on_local_meta_changed(&app);
    crate::sync::commands::on_unlocked(&app);
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
    let new_meta = stamped_change(&state, new_meta);
    save_meta(&app, &new_meta)?;
    state.set(key, new_meta.vault_id_bytes().map_err(|e| e.to_string())?);
    crate::sync::commands::on_local_meta_changed(&app);
    Ok(())
}

/// 0.9.1: replaces the recovery key (after re-checking the master password, which counts toward
/// the throttle) and returns the new one to show once. Synced like a password change. The old
/// key stops opening this vault; backup files made before still open with it.
#[tauri::command]
pub async fn vault_rotate_recovery_key(app: AppHandle, state: State<'_, VaultState>, password: String) -> Result<String, String> {
    if !state.is_unlocked() {
        return Err(ERR_LOCKED.into());
    }
    let meta = require_meta(&app)?;
    let password = Zeroizing::new(password);
    let (new_meta, recovery) = guarded(&state, move || {
        let key = vc::unlock_with_password(&meta, &password)?;
        vc::rewrap_recovery(&meta, &key)
    })
    .await?;
    let new_meta = stamped_change(&state, new_meta);
    save_meta(&app, &new_meta)?;
    crate::sync::commands::on_local_meta_changed(&app);
    Ok(recovery)
}

/// Drops the key from memory (zeroised on drop). With Vault Sync on and local changes pending,
/// first makes a best-effort upload (at most 10 s).
#[tauri::command]
pub async fn vault_lock(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    crate::sync::commands::before_lock(&app).await;
    let state = app.state::<VaultState>();
    let was_unlocked = state.guard().take().is_some();
    state.clear_db();
    if was_unlocked {
        notify_state(&app, false, window.label());
    }
    crate::sync::commands::notify_status(&app);
    Ok(())
}

// ─── the vault database (single encrypted file) ──────────────────────────────
// Notes are addressed by their "virtual path" `<root>/<rel>.nqv`; nothing but
// `<root>/vault.nqdb` exists on disk.

/// Tells the backend which folder holds `vault.nqdb`. Works while locked.
#[tauri::command]
pub fn vault_set_root(app: AppHandle, state: State<'_, VaultState>, root: String) -> Result<(), String> {
    if let Ok(dir) = app.path().app_data_dir() { state.ensure_device(&dir); }
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

// ─── 0.7.0: revision history ─────────────────────────────────────────────────

/// Earlier versions of a note, newest first (index 0). No content.
#[tauri::command]
pub fn vault_history_list(state: State<'_, VaultState>, path: String) -> Result<Vec<RevisionMeta>, String> {
    state.with_db(|db, root, _, _| Ok((db.history_list(&vdb::rel_from_full(root, &path)?)?, false)))
}

#[tauri::command]
pub fn vault_history_get(state: State<'_, VaultState>, path: String, index: u32) -> Result<VaultFile, String> {
    state.with_db(|db, root, _, _| {
        let r = db.history_get(&vdb::rel_from_full(root, &path)?, index as usize)?;
        Ok((VaultFile { content: r.content.clone(), ext: r.ext.clone() }, false))
    })
}

/// Makes revision `index` the current content; the current content becomes the newest revision.
#[tauri::command]
pub fn vault_history_restore(state: State<'_, VaultState>, path: String, index: u32) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.history_restore(&vdb::rel_from_full(root, &path)?, index as usize)?;
        Ok(((), true))
    })
}

// ─── 0.7.0: attachments (stored inside vault.nqdb) ───────────────────────────

/// Attaches a file (`data_b64` = standard base64 of its bytes) to a note.
#[tauri::command]
pub fn vault_attach_add(state: State<'_, VaultState>, path: String, name: String, data_b64: String) -> Result<AttachmentMeta, String> {
    let data_b64 = Zeroizing::new(data_b64);
    state.with_db(|db, root, _, _| Ok((db.attach_add(&vdb::rel_from_full(root, &path)?, &name, &data_b64)?, true)))
}

#[tauri::command]
pub fn vault_attach_list(state: State<'_, VaultState>, path: String) -> Result<Vec<AttachmentMeta>, String> {
    state.with_db(|db, root, _, _| Ok((db.attach_list(&vdb::rel_from_full(root, &path)?)?, false)))
}

/// The attachment's bytes as standard base64.
#[tauri::command]
pub fn vault_attach_get(state: State<'_, VaultState>, path: String, id: String) -> Result<String, String> {
    state.with_db(|db, root, _, _| Ok((db.attach_get(&vdb::rel_from_full(root, &path)?, &id)?.data.clone(), false)))
}

/// Refuses relative paths, a missing parent folder, the vault database or its backups,
/// and an existing file unless `overwrite`.
fn check_export_dest(root: &Path, dest: &Path, overwrite: bool) -> Result<(), String> {
    if !dest.is_absolute() || dest.file_name().is_none() {
        return Err("Choose a full file path to save the attachment to".into());
    }
    if !dest.parent().map(Path::is_dir).unwrap_or(false) {
        return Err("The destination folder doesn't exist".into());
    }
    let name = dest.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    let same_dir = |a: &Path, b: &Path| match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    };
    if name.starts_with(vdb::DB_FILE) && dest.parent().is_some_and(|p| same_dir(p, root)) {
        return Err("Can't overwrite the vault database".into());
    }
    if dest.is_dir() {
        return Err("The destination is a folder".into());
    }
    if dest.exists() && !overwrite {
        return Err("A file with that name already exists".into());
    }
    Ok(())
}

/// Writes the attachment's decrypted bytes to `dest_path` (an absolute path the user chose).
#[tauri::command]
pub fn vault_attach_export(
    state: State<'_, VaultState>,
    path: String,
    id: String,
    dest_path: String,
    overwrite: bool,
) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        let a = db.attach_get(&vdb::rel_from_full(root, &path)?, &id)?;
        let dest = PathBuf::from(&dest_path);
        check_export_dest(root, &dest, overwrite)?;
        let bytes = vdb::b64_decode(&a.data).ok_or("The attachment is damaged")?;
        atomic_write(&dest, &bytes)?;
        Ok(((), false))
    })
}

#[tauri::command]
pub fn vault_attach_remove(state: State<'_, VaultState>, path: String, id: String) -> Result<(), String> {
    state.with_db(|db, root, _, _| {
        db.attach_remove(&vdb::rel_from_full(root, &path)?, &id)?;
        Ok(((), true))
    })
}

// ─── default storage folder ──────────────────────────────────────────────────

/// Where the vault lives when the user hasn't chosen a folder: the app-data folder next to
/// vault.json. It is local (OneDrive/Dropbox don't sync it) and out of the user's way. A vault an
/// earlier version created in Documents/Notiq Vault keeps being used from there, so nothing is stranded.
fn pick_default_dir(app_data: &Path, legacy: Option<&Path>) -> PathBuf {
    if app_data.join(vdb::DB_FILE).exists() {
        return app_data.to_path_buf();
    }
    if let Some(l) = legacy {
        if l.join(vdb::DB_FILE).exists() || !legacy_files(l).is_empty() {
            return l.to_path_buf();
        }
    }
    app_data.to_path_buf()
}

#[tauri::command]
pub fn vault_default_dir(app: AppHandle) -> Result<String, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    // Dev builds never adopt a vault an installed (older) Notiq keeps in Documents.
    let legacy = if crate::profile::IS_DEV { None } else { app.path().document_dir().ok().map(|d| d.join("Notiq Vault")) };
    let dir = pick_default_dir(&app_data, legacy.as_deref());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_event_payload() {
        assert_eq!(STATE_EVENT, "vault:state-changed");
        assert_eq!(state_payload(true, "autofill-prompt"), serde_json::json!({"unlocked": true, "source": "autofill-prompt"}));
        assert_eq!(state_payload(false, "main")["unlocked"], serde_json::json!(false));
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nq-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn failed_attempts_count_up_and_are_taken_once() {
        let d = tmp("attempts");
        let p = d.join(ATTEMPTS_FILE);
        assert_eq!(take_attempts(&p), None, "no file");
        bump_attempts(&p, 1_000).unwrap();
        bump_attempts(&p, 5_000).unwrap();
        bump_attempts(&p, 3_000).unwrap(); // a clock set back never moves "last" backwards
        assert_eq!(read_attempts(&p), FailedAttempts { count: 3, last_ms: 5_000 });
        assert_eq!(take_attempts(&p), Some(FailedAttempts { count: 3, last_ms: 5_000 }));
        assert!(!p.exists(), "reset after a successful unlock");
        assert_eq!(take_attempts(&p), None);
        fs::write(&p, b"not json").unwrap();
        assert_eq!(take_attempts(&p), None, "a damaged file is just reset");
        bump_attempts(&p, 7).unwrap();
        assert_eq!(read_attempts(&p).count, 1);
        let _ = fs::remove_dir_all(d);
    }

    #[test]
    fn only_wrong_credentials_count_as_failed_attempts() {
        assert!(is_wrong_credential(&VaultError::WrongPassword.to_string()));
        assert!(is_wrong_credential(&VaultError::WrongRecoveryKey.to_string()));
        assert!(!is_wrong_credential(&VaultError::PasswordChangedElsewhere.to_string()));
        assert!(!is_wrong_credential("Too many attempts. Try again in 4s"));
    }

    #[test]
    fn default_dir_is_app_data_unless_an_older_vault_lives_in_documents() {
        let (app, docs) = (tmp("app"), tmp("docs"));
        // nothing anywhere -> app data
        assert_eq!(pick_default_dir(&app, Some(&docs)), app);
        // an old Documents vault database is kept
        fs::write(docs.join(vdb::DB_FILE), b"x").unwrap();
        assert_eq!(pick_default_dir(&app, Some(&docs)), docs);
        // once app data has its own database it wins
        fs::write(app.join(vdb::DB_FILE), b"x").unwrap();
        assert_eq!(pick_default_dir(&app, Some(&docs)), app);
        // old per-note files alone also count
        let (app2, docs2) = (tmp("app2"), tmp("docs2"));
        fs::write(docs2.join("a.nqv"), b"x").unwrap();
        assert_eq!(pick_default_dir(&app2, Some(&docs2)), docs2);
        assert_eq!(pick_default_dir(&app2, None), app2);
        for d in [app, docs, app2, docs2] { let _ = fs::remove_dir_all(d); }
    }

    #[test]
    fn export_destination_is_validated() {
        let (root, out) = (tmp("exp-root"), tmp("exp-out"));
        let f = out.join("a.png");
        assert!(check_export_dest(&root, &f, false).is_ok());
        assert!(check_export_dest(&root, Path::new("a.png"), true).is_err(), "relative");
        assert!(check_export_dest(&root, &out.join("missing").join("a.png"), true).is_err(), "no parent");
        assert!(check_export_dest(&root, &out, true).is_err(), "a folder");
        fs::write(&f, b"x").unwrap();
        assert!(check_export_dest(&root, &f, false).is_err());
        assert!(check_export_dest(&root, &f, true).is_ok());
        assert!(check_export_dest(&root, &root.join(vdb::DB_FILE), true).is_err());
        assert!(check_export_dest(&root, &root.join("VAULT.NQDB.bak.1"), true).is_err());
        for d in [root, out] { let _ = fs::remove_dir_all(d); }
    }
}
