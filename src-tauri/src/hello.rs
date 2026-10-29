//! 0.7.0 — optional, experimental "Unlock with Windows Hello" (off by default).
//!
//! Design
//! ------
//! * A Windows Hello **KeyCredential** named `notiq-vault-hello` (an RSA key held by the OS,
//!   usually in the TPM) is created when the user turns the feature on. Windows shows a Hello
//!   prompt (face / fingerprint / PIN) for *every* signature it makes.
//! * The credential signs the fixed challenge `NOTIQ-HELLO-KEK-v1|<vault_id hex>`. RSA PKCS#1 v1.5
//!   signatures are deterministic, so the same signature comes back every time; HKDF-SHA256 turns
//!   it into a 32-byte KEK. At enable time we sign twice and refuse if the two differ.
//! * `<app-data>/hello.json` holds the vault key wrapped by that KEK (XChaCha20-Poly1305, the
//!   vault id bound in as AAD). Without a Hello-approved signature it is useless.
//! * The master password stays the root secret: Hello is turned off (hello.json and the credential
//!   deleted) after 5 consecutive failures, when the Windows Hello key changes or disappears, when
//!   the vault is replaced by a restore, or whenever the stored key does not open the vault.
//!
//! Nothing here logs keys or signatures; KEK and signature buffers are zeroised.

use std::{fs, path::PathBuf};

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::vault::{atomic_write, guarded, require_meta, VaultState};
use crate::vault_core::{self as vc, VaultError, VaultKey, KEY_LEN, NONCE_LEN, VAULT_ID_LEN};

const HELLO_FILE: &str = "hello.json";
const FILE_VERSION: u32 = 1;
/// Consecutive failed Hello unlocks before Hello is turned off.
pub const MAX_FAILURES: u32 = 5;
const CHALLENGE_PREFIX: &str = "NOTIQ-HELLO-KEK-v1|";
const HKDF_SALT: &[u8] = b"notiq-hello-kek-v1";
const HKDF_INFO: &[u8] = b"notiq-hello-vault-key-wrap|";
const AAD_LABEL: &[u8] = b"nqv-wrap-hello-v1";
/// A Hello signature is an RSA-2048 (or larger) signature; anything shorter is not one.
const MIN_SIG_LEN: usize = 128;
const TAG_LEN: usize = 16;

pub type Kek = Zeroizing<[u8; KEY_LEN]>;

// ─── pure part (unit-tested) ─────────────────────────────────────────────────

/// `hello.json`. Contains no secret in the clear: `ct` is the vault key wrapped under a KEK that
/// only a Hello-approved signature can rebuild.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HelloFile {
    pub v: u32,
    /// hex, 16 bytes
    pub vault_id: String,
    /// hex, 24 bytes
    pub nonce: String,
    /// hex, 32-byte key + 16-byte tag
    pub ct: String,
    /// Consecutive failed Hello unlocks.
    #[serde(default)]
    pub fails: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum HelloError {
    BadFile(&'static str),
    /// hello.json belongs to another vault.
    VaultMismatch,
    /// The KEK doesn't open the wrap (the Hello key changed, or the file was modified).
    Unwrap,
}

impl HelloFile {
    pub fn parse(s: &str) -> Result<Self, HelloError> {
        let f: HelloFile = serde_json::from_str(s).map_err(|_| HelloError::BadFile("not valid json"))?;
        if f.v != FILE_VERSION {
            return Err(HelloError::BadFile("unsupported version"));
        }
        if hex_decode(&f.vault_id).map(|b| b.len()) != Some(VAULT_ID_LEN) {
            return Err(HelloError::BadFile("vault_id"));
        }
        if hex_decode(&f.nonce).map(|b| b.len()) != Some(NONCE_LEN) {
            return Err(HelloError::BadFile("nonce"));
        }
        if hex_decode(&f.ct).map(|b| b.len()) != Some(KEY_LEN + TAG_LEN) {
            return Err(HelloError::BadFile("ct"));
        }
        if f.fails >= MAX_FAILURES {
            return Err(HelloError::BadFile("too many failures"));
        }
        Ok(f)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("hello file serialises")
    }

    pub fn is_for(&self, vault_id: &[u8; VAULT_ID_LEN]) -> bool {
        hex_decode(&self.vault_id).as_deref() == Some(&vault_id[..])
    }

    /// Counts a failed Hello unlock. `true` when Hello must now be turned off.
    pub fn record_failure(&mut self) -> bool {
        self.fails = self.fails.saturating_add(1);
        self.fails >= MAX_FAILURES
    }
}

/// The bytes the Hello credential signs for this vault.
pub fn challenge(vault_id: &[u8; VAULT_ID_LEN]) -> Vec<u8> {
    format!("{CHALLENGE_PREFIX}{}", hex_encode(vault_id)).into_bytes()
}

/// The two enable-time signatures must be identical (PKCS#1 v1.5 is deterministic) and look like
/// a real signature; otherwise the KEK could never be rebuilt.
pub fn signatures_agree(a: &[u8], b: &[u8]) -> bool {
    a.len() >= MIN_SIG_LEN && a == b
}

/// HKDF-SHA256(signature) → 32-byte KEK, bound to the vault id.
pub fn derive_kek(signature: &[u8], vault_id: &[u8; VAULT_ID_LEN]) -> Kek {
    let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), signature);
    let mut info = HKDF_INFO.to_vec();
    info.extend_from_slice(vault_id);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(&info, &mut *out).expect("32 bytes is a valid HKDF-SHA256 length");
    out
}

fn aad(vault_id: &[u8; VAULT_ID_LEN]) -> Vec<u8> {
    let mut v = AAD_LABEL.to_vec();
    v.extend_from_slice(vault_id);
    v
}

/// Wraps the vault key under `kek` (fresh random nonce).
pub fn wrap_key(kek: &Kek, vault_id: &[u8; VAULT_ID_LEN], key: &VaultKey) -> Result<HelloFile, VaultError> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&kek[..]));
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: &key[..], aad: &aad(vault_id) })
        .map_err(|_| VaultError::Crypto)?;
    Ok(HelloFile { v: FILE_VERSION, vault_id: hex_encode(vault_id), nonce: hex_encode(&nonce), ct: hex_encode(&ct), fails: 0 })
}

/// Unwraps the vault key; refuses a file made for another vault or a wrong KEK / tampered file.
pub fn unwrap_key(f: &HelloFile, kek: &Kek, vault_id: &[u8; VAULT_ID_LEN]) -> Result<VaultKey, HelloError> {
    if !f.is_for(vault_id) {
        return Err(HelloError::VaultMismatch);
    }
    let nonce = hex_decode(&f.nonce).filter(|n| n.len() == NONCE_LEN).ok_or(HelloError::BadFile("nonce"))?;
    let ct = hex_decode(&f.ct).ok_or(HelloError::BadFile("ct"))?;
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&kek[..]));
    let pt = Zeroizing::new(
        cipher
            .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad: &aad(vault_id) })
            .map_err(|_| HelloError::Unwrap)?,
    );
    if pt.len() != KEY_LEN {
        return Err(HelloError::Unwrap);
    }
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    key.copy_from_slice(&pt);
    Ok(key)
}

/// `false` only when the vault database provably was not sealed with `key` for `vault_id`.
/// A missing or unreadable file can't prove anything (the password path would hit the same).
fn key_opens_db(db_bytes: Option<&[u8]>, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN]) -> bool {
    match db_bytes {
        None => true,
        Some(b) => !matches!(vc::open(key, vault_id, b), Err(VaultError::Tampered | VaultError::VaultMismatch)),
    }
}

fn hex_encode(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for &x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok()).collect()
}

// ─── platform: the Windows Hello KeyCredential ───────────────────────────────

pub enum SignErr {
    /// The user cancelled the prompt or chose to use a password instead.
    Canceled,
    /// The credential no longer exists (Windows Hello was reset / removed).
    NotFound,
    Failed(String),
}

#[cfg(windows)]
mod platform {
    use super::SignErr;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    use std::time::Duration;
    use windows::core::{Array, HSTRING};
    use windows::Security::Credentials::{
        KeyCredential, KeyCredentialCreationOption, KeyCredentialManager, KeyCredentialStatus,
    };
    use windows::Security::Cryptography::CryptographicBuffer;
    use zeroize::Zeroizing;

    const CRED_NAME: &str = "notiq-vault-hello";

    impl From<windows::core::Error> for SignErr {
        fn from(e: windows::core::Error) -> Self {
            SignErr::Failed(format!("Windows Hello failed ({})", e.message()))
        }
    }

    fn status_err(s: KeyCredentialStatus) -> SignErr {
        match s {
            KeyCredentialStatus::UserCanceled | KeyCredentialStatus::UserPrefersPassword => SignErr::Canceled,
            KeyCredentialStatus::NotFound => SignErr::NotFound,
            KeyCredentialStatus::SecurityDeviceLocked => {
                SignErr::Failed("Windows Hello is locked after too many attempts. Sign in to Windows with your PIN, then try again.".into())
            }
            _ => SignErr::Failed("Windows Hello couldn't verify you".into()),
        }
    }

    /// The Hello dialog is owned by a system process and can open behind Notiq; bring it forward
    /// (best effort) until it appears or the operation finishes.
    fn nudge_dialog(done: Arc<AtomicBool>) {
        std::thread::spawn(move || {
            use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, SetForegroundWindow};
            let class: Vec<u16> = "Credential Dialog Xaml Host\0".encode_utf16().collect();
            for _ in 0..60 {
                if done.load(Ordering::Relaxed) {
                    return;
                }
                // SAFETY: a NUL-terminated UTF-16 class name and a null window name.
                let h = unsafe { FindWindowW(class.as_ptr(), std::ptr::null()) };
                if !h.is_null() {
                    // SAFETY: `h` is a window handle FindWindowW just returned.
                    unsafe { SetForegroundWindow(h) };
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        });
    }

    /// Runs one Hello-prompting operation with the dialog nudge active.
    fn prompting<T>(f: impl FnOnce() -> Result<T, SignErr>) -> Result<T, SignErr> {
        let done = Arc::new(AtomicBool::new(false));
        nudge_dialog(done.clone());
        let r = f();
        done.store(true, Ordering::Relaxed);
        r
    }

    fn sign(cred: &KeyCredential, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, SignErr> {
        let buf = CryptographicBuffer::CreateFromByteArray(data)?;
        let r = prompting(|| Ok(cred.RequestSignAsync(&buf)?.join()?))?;
        let st = r.Status()?;
        if st != KeyCredentialStatus::Success {
            return Err(status_err(st));
        }
        let out = r.Result()?;
        let mut arr = Array::<u8>::new();
        CryptographicBuffer::CopyToByteArray(&out, &mut arr)?;
        let sig = Zeroizing::new(arr.to_vec());
        arr.iter_mut().for_each(|b| *b = 0);
        Ok(sig)
    }

    pub fn supported() -> bool {
        KeyCredentialManager::IsSupportedAsync().and_then(|op| op.join()).unwrap_or(false)
    }

    /// Creates (or replaces) the credential and signs `challenge` twice; both must agree.
    pub fn create_and_sign(challenge: &[u8]) -> Result<Zeroizing<Vec<u8>>, SignErr> {
        let name = HSTRING::from(CRED_NAME);
        let r = prompting(|| Ok(KeyCredentialManager::RequestCreateAsync(&name, KeyCredentialCreationOption::ReplaceExisting)?.join()?))?;
        let st = r.Status()?;
        if st != KeyCredentialStatus::Success {
            return Err(status_err(st));
        }
        let cred = r.Credential()?;
        let result = (|| {
            let a = sign(&cred, challenge)?;
            let b = sign(&cred, challenge)?;
            if !super::signatures_agree(&a, &b) {
                return Err(SignErr::Failed(
                    "This PC's Windows Hello key doesn't give repeatable signatures, so it can't be used to unlock the vault".into(),
                ));
            }
            Ok(a)
        })();
        if result.is_err() {
            delete();
        }
        result
    }

    /// Opens the existing credential and signs `challenge` (one Hello prompt).
    pub fn open_and_sign(challenge: &[u8]) -> Result<Zeroizing<Vec<u8>>, SignErr> {
        let r = KeyCredentialManager::OpenAsync(&HSTRING::from(CRED_NAME))?.join()?;
        let st = r.Status()?;
        if st != KeyCredentialStatus::Success {
            return Err(status_err(st));
        }
        sign(&r.Credential()?, challenge)
    }

    /// Deletes the credential (best effort; a missing one is fine).
    pub fn delete() {
        if let Ok(op) = KeyCredentialManager::DeleteAsync(&HSTRING::from(CRED_NAME)) {
            let _ = op.join();
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::SignErr;
    use zeroize::Zeroizing;

    const UNSUPPORTED: &str = "Windows Hello is only available on Windows";

    pub fn supported() -> bool {
        false
    }
    pub fn create_and_sign(_: &[u8]) -> Result<Zeroizing<Vec<u8>>, SignErr> {
        Err(SignErr::Failed(UNSUPPORTED.into()))
    }
    pub fn open_and_sign(_: &[u8]) -> Result<Zeroizing<Vec<u8>>, SignErr> {
        Err(SignErr::Failed(UNSUPPORTED.into()))
    }
    pub fn delete() {}
}

// ─── file + lifecycle helpers ────────────────────────────────────────────────

fn hello_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(HELLO_FILE))
}

fn read_file(app: &AppHandle) -> Result<Option<HelloFile>, String> {
    match fs::read_to_string(hello_path(app)?) {
        Ok(s) => Ok(HelloFile::parse(&s).ok()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

async fn run_blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// Turns Hello off: deletes hello.json now and the credential in the background.
/// Called on disable, on any invalidation, and when a backup replaces the vault.
pub(crate) fn invalidate(app: &AppHandle) {
    if let Ok(p) = hello_path(app) {
        let _ = fs::remove_file(p);
    }
    std::thread::spawn(platform::delete);
}

const MSG_TURNED_OFF: &str =
    "Windows Hello unlock has been turned off. Unlock with your master password; you can turn Hello on again in Settings.";

// ─── commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct HelloStatus {
    supported: bool,
    enabled: bool,
}

#[tauri::command]
pub async fn hello_status(app: AppHandle) -> Result<HelloStatus, String> {
    let supported = run_blocking(platform::supported).await?;
    if !supported {
        return Ok(HelloStatus { supported, enabled: false });
    }
    let path = hello_path(&app)?;
    if !path.exists() {
        return Ok(HelloStatus { supported, enabled: false });
    }
    let current = crate::vault::load_meta(&app)?.and_then(|m| m.vault_id_bytes().ok());
    let enabled = match (read_file(&app)?, current) {
        (Some(f), Some(id)) => f.is_for(&id),
        _ => false,
    };
    if !enabled {
        invalidate(&app); // stale: unreadable, too many failures, or another vault
    }
    Ok(HelloStatus { supported, enabled })
}

/// Turns Hello on. The vault must be unlocked and the master password re-entered
/// (checked through the throttled password path).
#[tauri::command]
pub async fn hello_enable(app: AppHandle, state: State<'_, VaultState>, password: String) -> Result<(), String> {
    if !state.is_unlocked() {
        return Err("VAULT_LOCKED".into());
    }
    if !run_blocking(platform::supported).await? {
        return Err("Windows Hello isn't set up on this PC".into());
    }
    let meta = require_meta(&app)?;
    let vault_id = meta.vault_id_bytes().map_err(|e| e.to_string())?;
    let password = Zeroizing::new(password);
    let m = meta.clone();
    let key = guarded(&state, move || vc::unlock_with_password(&m, &password)).await?;

    let ch = challenge(&vault_id);
    let sig = run_blocking(move || platform::create_and_sign(&ch)).await?.map_err(|e| match e {
        SignErr::Canceled => "Windows Hello was cancelled. Nothing was changed.".to_string(),
        SignErr::NotFound => "Windows Hello couldn't create a key. Nothing was changed.".to_string(),
        SignErr::Failed(m) => m,
    })?;
    let kek = derive_kek(&sig, &vault_id);
    drop(sig);
    let file = match wrap_key(&kek, &vault_id, &key) {
        Ok(f) => f,
        Err(e) => {
            invalidate(&app);
            return Err(e.to_string());
        }
    };
    if let Err(e) = atomic_write(&hello_path(&app)?, file.to_json().as_bytes()) {
        invalidate(&app);
        return Err(e);
    }
    Ok(())
}

#[tauri::command]
pub async fn hello_disable(app: AppHandle) -> Result<(), String> {
    let path = hello_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    run_blocking(platform::delete).await
}

/// Hello prompt → signature → KEK → unwrap → the vault is unlocked exactly like a password unlock.
#[tauri::command]
pub async fn hello_unlock(app: AppHandle, window: tauri::Window, state: State<'_, VaultState>) -> Result<(), String> {
    let meta = require_meta(&app)?;
    let vault_id = meta.vault_id_bytes().map_err(|e| e.to_string())?;
    let Some(mut file) = read_file(&app)? else {
        invalidate(&app);
        return Err("Windows Hello unlock isn't turned on. Unlock with your master password.".into());
    };
    if !file.is_for(&vault_id) {
        invalidate(&app);
        return Err(MSG_TURNED_OFF.into());
    }

    let ch = challenge(&vault_id);
    let sig = match run_blocking(move || platform::open_and_sign(&ch)).await? {
        Ok(s) => s,
        Err(SignErr::Canceled) => return Err("Windows Hello was cancelled. Use your master password or try again.".into()),
        Err(SignErr::NotFound) => {
            invalidate(&app);
            return Err(format!("Windows Hello on this PC was changed. {MSG_TURNED_OFF}"));
        }
        Err(SignErr::Failed(m)) => {
            if file.record_failure() {
                invalidate(&app);
                return Err(format!("{m}. {MSG_TURNED_OFF}"));
            }
            let _ = atomic_write(&hello_path(&app)?, file.to_json().as_bytes());
            return Err(m);
        }
    };
    let kek = derive_kek(&sig, &vault_id);
    drop(sig);
    let key = match unwrap_key(&file, &kek, &vault_id) {
        Ok(k) => k,
        Err(_) => {
            // The Hello key changed (e.g. Windows Hello was reset) or the file was modified.
            invalidate(&app);
            return Err(MSG_TURNED_OFF.into());
        }
    };
    drop(kek);

    // Defence in depth: the key must actually open this vault's database.
    let db_bytes = state.root().and_then(|r| fs::read(crate::vault_db::db_path(&r)).ok());
    if !key_opens_db(db_bytes.as_deref(), &key, &vault_id) {
        invalidate(&app);
        return Err(MSG_TURNED_OFF.into());
    }

    if file.fails != 0 {
        file.fails = 0;
        let _ = atomic_write(&hello_path(&app)?, file.to_json().as_bytes());
    }
    state.install_key(key, vault_id);
    crate::vault::notify_state(&app, true, window.label());
    Ok(())
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    const ID: [u8; VAULT_ID_LEN] = [7; VAULT_ID_LEN];

    fn key() -> VaultKey {
        Zeroizing::new([42u8; KEY_LEN])
    }

    fn fake_sig(byte: u8) -> Vec<u8> {
        vec![byte; 256]
    }

    #[test]
    fn challenge_is_fixed_and_bound_to_the_vault() {
        let c = String::from_utf8(challenge(&ID)).unwrap();
        assert_eq!(c, format!("NOTIQ-HELLO-KEK-v1|{}", "07".repeat(16)));
        assert_ne!(challenge(&ID), challenge(&[8; VAULT_ID_LEN]));
    }

    #[test]
    fn kek_is_deterministic_and_depends_on_signature_and_vault() {
        let a = derive_kek(&fake_sig(1), &ID);
        assert_eq!(*a, *derive_kek(&fake_sig(1), &ID));
        assert_ne!(*a, *derive_kek(&fake_sig(2), &ID));
        assert_ne!(*a, *derive_kek(&fake_sig(1), &[8; VAULT_ID_LEN]));
    }

    #[test]
    fn wrap_unwrap_round_trip() {
        let kek = derive_kek(&fake_sig(1), &ID);
        let f = wrap_key(&kek, &ID, &key()).unwrap();
        let json = f.to_json();
        assert!(!json.contains(&"2a".repeat(KEY_LEN)), "key must not appear in the clear");
        let back = HelloFile::parse(&json).unwrap();
        assert_eq!(*unwrap_key(&back, &kek, &ID).unwrap(), *key());
        // a fresh nonce every time
        assert_ne!(wrap_key(&kek, &ID, &key()).unwrap().nonce, f.nonce);
    }

    #[test]
    fn wrong_kek_and_tampering_are_rejected() {
        let kek = derive_kek(&fake_sig(1), &ID);
        let f = wrap_key(&kek, &ID, &key()).unwrap();
        let other = derive_kek(&fake_sig(2), &ID);
        assert_eq!(unwrap_key(&f, &other, &ID).unwrap_err(), HelloError::Unwrap);
        for field in 0..2 {
            let mut bad = f.clone();
            let s = if field == 0 { &mut bad.ct } else { &mut bad.nonce };
            let flipped = if s.as_bytes()[0] == b'0' { "1" } else { "0" };
            s.replace_range(0..1, flipped);
            assert_eq!(unwrap_key(&bad, &kek, &ID).unwrap_err(), HelloError::Unwrap);
        }
    }

    #[test]
    fn vault_id_mismatch_is_rejected() {
        let kek = derive_kek(&fake_sig(1), &ID);
        let f = wrap_key(&kek, &ID, &key()).unwrap();
        let other = [8; VAULT_ID_LEN];
        assert_eq!(unwrap_key(&f, &kek, &other).unwrap_err(), HelloError::VaultMismatch);
        // relabelling the file for the other vault doesn't help: the vault id is in the AAD
        let mut relabelled = f.clone();
        relabelled.vault_id = hex_encode(&other);
        assert_eq!(unwrap_key(&relabelled, &kek, &other).unwrap_err(), HelloError::Unwrap);
    }

    #[test]
    fn hello_json_is_validated() {
        let kek = derive_kek(&fake_sig(1), &ID);
        let good = wrap_key(&kek, &ID, &key()).unwrap();
        assert!(HelloFile::parse(&good.to_json()).is_ok());
        assert!(HelloFile::parse("{").is_err());
        assert!(HelloFile::parse("{}").is_err());
        let check = |f: HelloFile| HelloFile::parse(&f.to_json()).is_err();
        assert!(check(HelloFile { v: 2, ..good.clone() }));
        assert!(check(HelloFile { vault_id: "abcd".into(), ..good.clone() }));
        assert!(check(HelloFile { vault_id: "zz".repeat(16), ..good.clone() }));
        assert!(check(HelloFile { nonce: "00".repeat(12), ..good.clone() }));
        assert!(check(HelloFile { ct: "00".repeat(32), ..good.clone() }));
        assert!(check(HelloFile { fails: MAX_FAILURES, ..good.clone() }));
        // `fails` is optional on disk (the spec'd shape is {v, vault_id, nonce, ct})
        let minimal = format!(r#"{{"v":1,"vault_id":"{}","nonce":"{}","ct":"{}"}}"#, good.vault_id, good.nonce, good.ct);
        assert_eq!(HelloFile::parse(&minimal).unwrap().fails, 0);
    }

    #[test]
    fn five_consecutive_failures_turn_hello_off() {
        let kek = derive_kek(&fake_sig(1), &ID);
        let mut f = wrap_key(&kek, &ID, &key()).unwrap();
        for i in 1..MAX_FAILURES {
            assert!(!f.record_failure(), "failure {i} must not disable yet");
            assert!(HelloFile::parse(&f.to_json()).is_ok());
        }
        assert!(f.record_failure());
        assert!(HelloFile::parse(&f.to_json()).is_err(), "a file at the limit is never accepted");
    }

    #[test]
    fn enable_time_signatures_must_agree() {
        assert!(signatures_agree(&fake_sig(1), &fake_sig(1)));
        assert!(!signatures_agree(&fake_sig(1), &fake_sig(2)));
        assert!(!signatures_agree(&[], &[]));
        assert!(!signatures_agree(&[1; 16], &[1; 16]));
    }

    #[test]
    fn key_must_open_the_vault_database() {
        let id = ID;
        let db = vc::seal(&key(), &id, "db", b"{}").unwrap();
        assert!(key_opens_db(Some(&db), &key(), &id));
        assert!(key_opens_db(None, &key(), &id));
        let wrong: VaultKey = Zeroizing::new([1u8; KEY_LEN]);
        assert!(!key_opens_db(Some(&db), &wrong, &id));
        assert!(!key_opens_db(Some(&db), &key(), &[8; VAULT_ID_LEN]));
        // garbage that isn't a sealed file proves nothing either way
        assert!(key_opens_db(Some(b"junk"), &key(), &id));
    }
}
