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
    time::Instant,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::vault_core::{self as vc, KdfParams, Throttle, VaultError, VaultKey, VaultMeta, VAULT_ID_LEN};

const META_FILE: &str = "vault.json";
const NQV_EXT: &str = "nqv";
/// Refuse to read absurdly large files into memory.
const MAX_NQV_BYTES: u64 = 64 * 1024 * 1024;

const ERR_NO_VAULT: &str = "NO_VAULT";
const ERR_LOCKED: &str = "VAULT_LOCKED";

struct Unlocked {
    key: VaultKey,
    vault_id: [u8; VAULT_ID_LEN],
}

#[derive(Default)]
pub struct VaultState {
    key: Mutex<Option<Unlocked>>,
    throttle: Mutex<Throttle>,
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

    /// Runs `f` with the unlocked key; `VAULT_LOCKED` if the vault is locked.
    /// The key never leaves this call.
    pub(crate) fn with_unlocked<T>(
        &self,
        f: impl FnOnce(&VaultKey, &[u8; VAULT_ID_LEN]) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self.guard();
        let u = guard.as_ref().ok_or(ERR_LOCKED)?;
        f(&u.key, &u.vault_id)
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

/// The key file as stored (password/recovery-wrapped keys only — no secrets in clear).
pub(crate) fn read_meta_json(app: &AppHandle) -> Result<Option<String>, String> {
    Ok(load_meta(app)?.map(|m| m.to_json()))
}

/// Install a key file fetched from a backup on a device that has no vault yet.
pub(crate) fn install_meta_json(app: &AppHandle, json: &str) -> Result<(), String> {
    if load_meta(app)?.is_some() {
        return Err("A vault already exists on this device".into());
    }
    let meta = VaultMeta::from_json(json).map_err(|e| e.to_string())?;
    save_meta(app, &meta)
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
}

/// Encrypts `content` and atomically writes it to `path` (must end in `.nqv`).
/// `ext` is the original file type, e.g. "md".
#[tauri::command]
pub fn vault_write_file(
    state: State<'_, VaultState>,
    path: String,
    content: String,
    ext: String,
) -> Result<(), String> {
    let path = check_nqv_path(&path)?;
    let sealed = {
        let guard = state.guard();
        let u = guard.as_ref().ok_or(ERR_LOCKED)?;
        vc::seal(&u.key, &u.vault_id, &ext, content.as_bytes()).map_err(|e| e.to_string())?
    };
    atomic_write(&path, &sealed)
}

/// Reads and decrypts a `.nqv` file. Plaintext is returned to the caller only;
/// nothing is written to disk.
#[tauri::command]
pub fn vault_read_file(state: State<'_, VaultState>, path: String) -> Result<VaultFile, String> {
    let path = check_nqv_path(&path)?;
    let size = fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size > MAX_NQV_BYTES {
        return Err("Vault file is too large".into());
    }
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    let (ext, plain) = {
        let guard = state.guard();
        let u = guard.as_ref().ok_or(ERR_LOCKED)?;
        vc::open(&u.key, &u.vault_id, &data).map_err(|e| e.to_string())?
    };
    let content = String::from_utf8(plain.to_vec()).map_err(|_| "Note is not valid UTF-8 text".to_string())?;
    Ok(VaultFile { content, ext })
}
