//! Secure Vault — pure crypto core (no Tauri dependency, fully unit-testable).
//!
//! Design
//! ------
//! * A random 256-bit **vault key** encrypts every `.nqv` note.
//! * The vault key is stored only in *wrapped* form inside `vault.json`:
//!     - wrapped by a KEK derived from the master password (Argon2id), and
//!     - wrapped by the random 256-bit **recovery key** shown once at setup.
//!   Changing the password re-wraps the key; notes never need re-encrypting.
//! * Notes are sealed with XChaCha20-Poly1305 (random 192-bit nonce per save).
//!   The header is authenticated as AAD, so tampering with it is detected.
//!
//! `.nqv` file layout
//! ------------------
//! ```text
//! "NQV1" | version u8 | vault_id[16] | ext_len u8 | ext[ext_len] | nonce[24] | ciphertext+tag
//! ```
//! AAD = everything before `nonce`.

use argon2::{Algorithm, Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    Key, XChaCha20Poly1305, XNonce,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 4] = b"NQV1";
pub const FORMAT_VERSION: u8 = 1;
pub const META_VERSION: u32 = 1;
pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;
pub const VAULT_ID_LEN: usize = 16;
pub const MAX_EXT_LEN: usize = 16;
pub const MIN_PASSWORD_LEN: usize = 8;

const AAD_WRAP_PW: &[u8] = b"nqv-wrap-pw-v1";
const AAD_WRAP_REC: &[u8] = b"nqv-wrap-rec-v1";
const B32: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// The unwrapped vault key. Zeroed on drop.
pub type VaultKey = Zeroizing<[u8; KEY_LEN]>;

#[derive(Debug, PartialEq, Eq)]
pub enum VaultError {
    WeakPassword,
    WrongPassword,
    WrongRecoveryKey,
    BadMeta(&'static str),
    Corrupt(&'static str),
    UnsupportedVersion(u8),
    /// File was sealed by a different vault than the one currently unlocked.
    VaultMismatch,
    /// Authentication failed: wrong key or the file was modified.
    Tampered,
    Crypto,
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WeakPassword => write!(f, "Password must be at least {MIN_PASSWORD_LEN} characters"),
            Self::WrongPassword => write!(f, "Wrong password"),
            Self::WrongRecoveryKey => write!(f, "Wrong recovery key"),
            Self::BadMeta(m) => write!(f, "Vault metadata is invalid: {m}"),
            Self::Corrupt(m) => write!(f, "Vault file is corrupt: {m}"),
            Self::UnsupportedVersion(v) => write!(f, "Unsupported vault file version {v}"),
            Self::VaultMismatch => write!(f, "This file belongs to a different vault"),
            Self::Tampered => write!(f, "File could not be verified (wrong key or modified)"),
            Self::Crypto => write!(f, "Cryptographic operation failed"),
        }
    }
}

impl std::error::Error for VaultError {}

type Result<T> = std::result::Result<T, VaultError>;

// ─── Metadata (vault.json) ───────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

impl Default for KdfParams {
    fn default() -> Self {
        // ~64 MiB, 3 passes: a few hundred ms on a desktop CPU.
        Self { m_kib: 64 * 1024, t: 3, p: 1 }
    }
}

impl KdfParams {
    /// Reject absurd values from a tampered/foreign vault.json (DoS guard).
    fn validate(&self) -> Result<()> {
        if self.m_kib < 8 || self.m_kib > 1024 * 1024 || self.t < 1 || self.t > 20 || self.p < 1 || self.p > 16 {
            return Err(VaultError::BadMeta("kdf parameters out of range"));
        }
        Ok(())
    }
}

/// Serialised to `vault.json`. Contains no secrets in the clear.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultMeta {
    pub version: u32,
    /// hex, 16 bytes — identifies which vault sealed a `.nqv` file.
    pub vault_id: String,
    pub kdf: KdfParams,
    /// hex, 16 bytes — Argon2id salt.
    pub salt: String,
    /// hex — nonce || ciphertext of the vault key under the password KEK.
    pub pw_wrap: String,
    /// hex — nonce || ciphertext of the vault key under the recovery key.
    pub rec_wrap: String,
}

impl VaultMeta {
    pub fn vault_id_bytes(&self) -> Result<[u8; VAULT_ID_LEN]> {
        hex_decode(&self.vault_id)
            .and_then(|v| v.try_into().ok())
            .ok_or(VaultError::BadMeta("vault_id"))
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("meta serialises")
    }

    pub fn from_json(s: &str) -> Result<Self> {
        let m: VaultMeta = serde_json::from_str(s).map_err(|_| VaultError::BadMeta("not valid json"))?;
        if m.version != META_VERSION {
            return Err(VaultError::BadMeta("unsupported meta version"));
        }
        m.kdf.validate()?;
        m.vault_id_bytes()?;
        Ok(m)
    }
}

// ─── Vault lifecycle ─────────────────────────────────────────────────────────

/// Creates a brand-new vault. Returns the metadata to persist, the unlocked
/// key, and the recovery key string (show it to the user exactly once).
pub fn create_vault(password: &str, kdf: KdfParams) -> Result<(VaultMeta, VaultKey, String)> {
    check_password(password)?;
    kdf.validate()?;

    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    OsRng.fill_bytes(&mut *key);
    let mut vault_id = [0u8; VAULT_ID_LEN];
    OsRng.fill_bytes(&mut vault_id);
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut recovery = Zeroizing::new([0u8; KEY_LEN]);
    OsRng.fill_bytes(&mut *recovery);

    let kek = derive_kek(password, &salt, &kdf)?;
    let meta = VaultMeta {
        version: META_VERSION,
        vault_id: hex_encode(&vault_id),
        kdf,
        salt: hex_encode(&salt),
        pw_wrap: hex_encode(&wrap(&kek, &aad(AAD_WRAP_PW, &vault_id), &key)?),
        rec_wrap: hex_encode(&wrap(&recovery, &aad(AAD_WRAP_REC, &vault_id), &key)?),
    };
    Ok((meta, key, format_recovery_key(&recovery)))
}

pub fn unlock_with_password(meta: &VaultMeta, password: &str) -> Result<VaultKey> {
    meta.kdf.validate()?;
    let vault_id = meta.vault_id_bytes()?;
    let salt = hex_decode(&meta.salt).ok_or(VaultError::BadMeta("salt"))?;
    let blob = hex_decode(&meta.pw_wrap).ok_or(VaultError::BadMeta("pw_wrap"))?;
    let kek = derive_kek(password, &salt, &meta.kdf)?;
    unwrap(&kek, &aad(AAD_WRAP_PW, &vault_id), &blob).ok_or(VaultError::WrongPassword)
}

pub fn unlock_with_recovery(meta: &VaultMeta, recovery: &str) -> Result<VaultKey> {
    let vault_id = meta.vault_id_bytes()?;
    let blob = hex_decode(&meta.rec_wrap).ok_or(VaultError::BadMeta("rec_wrap"))?;
    let rk = parse_recovery_key(recovery).ok_or(VaultError::WrongRecoveryKey)?;
    unwrap(&rk, &aad(AAD_WRAP_REC, &vault_id), &blob).ok_or(VaultError::WrongRecoveryKey)
}

/// Re-wraps the (already unlocked) vault key under a new password. Uses a
/// fresh salt. The recovery wrap and every `.nqv` file stay valid.
pub fn rewrap_password(meta: &VaultMeta, key: &VaultKey, new_password: &str) -> Result<VaultMeta> {
    check_password(new_password)?;
    let vault_id = meta.vault_id_bytes()?;
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let kek = derive_kek(new_password, &salt, &meta.kdf)?;
    let mut out = meta.clone();
    out.salt = hex_encode(&salt);
    out.pw_wrap = hex_encode(&wrap(&kek, &aad(AAD_WRAP_PW, &vault_id), key)?);
    Ok(out)
}

// ─── Note sealing ────────────────────────────────────────────────────────────

/// Encrypts `plaintext` into a complete `.nqv` file image.
/// `ext` is the original file type (e.g. `"md"`), stored authenticated.
pub fn seal(key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], ext: &str, plaintext: &[u8]) -> Result<Vec<u8>> {
    if ext.len() > MAX_EXT_LEN || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err(VaultError::Corrupt("invalid extension"));
    }
    let mut out = Vec::with_capacity(4 + 1 + VAULT_ID_LEN + 1 + ext.len() + NONCE_LEN + plaintext.len() + 16);
    out.extend_from_slice(MAGIC);
    out.push(FORMAT_VERSION);
    out.extend_from_slice(vault_id);
    out.push(ext.len() as u8);
    out.extend_from_slice(ext.as_bytes());
    let header_len = out.len();

    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &out[..header_len] })
        .map_err(|_| VaultError::Crypto)?;
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Decrypts a `.nqv` file image. Returns `(ext, plaintext)`.
pub fn open(key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], data: &[u8]) -> Result<(String, Zeroizing<Vec<u8>>)> {
    let min = 4 + 1 + VAULT_ID_LEN + 1 + NONCE_LEN + 16;
    if data.len() < min {
        return Err(VaultError::Corrupt("file too short"));
    }
    if &data[..4] != MAGIC {
        return Err(VaultError::Corrupt("not a .nqv file"));
    }
    if data[4] != FORMAT_VERSION {
        return Err(VaultError::UnsupportedVersion(data[4]));
    }
    if &data[5..5 + VAULT_ID_LEN] != vault_id {
        return Err(VaultError::VaultMismatch);
    }
    let ext_len = data[5 + VAULT_ID_LEN] as usize;
    let ext_start = 5 + VAULT_ID_LEN + 1;
    let header_len = ext_start + ext_len;
    if ext_len > MAX_EXT_LEN || data.len() < header_len + NONCE_LEN + 16 {
        return Err(VaultError::Corrupt("bad header"));
    }
    let ext = std::str::from_utf8(&data[ext_start..header_len])
        .map_err(|_| VaultError::Corrupt("bad extension"))?
        .to_string();
    let nonce = &data[header_len..header_len + NONCE_LEN];
    let ct = &data[header_len + NONCE_LEN..];

    let cipher = XChaCha20Poly1305::new(Key::from_slice(&key[..]));
    let pt = cipher
        .decrypt(XNonce::from_slice(nonce), Payload { msg: ct, aad: &data[..header_len] })
        .map_err(|_| VaultError::Tampered)?;
    Ok((ext, Zeroizing::new(pt)))
}

// ─── Failed-attempt throttle ─────────────────────────────────────────────────

/// Free attempts before any delay kicks in.
const FREE_ATTEMPTS: u32 = 3;
const MAX_DELAY_SECS: u64 = 60;

/// Delay imposed after `failures` consecutive wrong credentials:
/// none for the first 3, then 2s, 4s, 8s … capped at 60s.
pub fn throttle_delay(failures: u32) -> Duration {
    if failures < FREE_ATTEMPTS {
        return Duration::ZERO;
    }
    let exp = (failures - FREE_ATTEMPTS).min(6); // 2<<6 = 128 > cap; avoids overflow
    Duration::from_secs((2u64 << exp).min(MAX_DELAY_SECS))
}

/// Slows down online guessing through the app UI. This is NOT a defence against
/// someone copying `vault.json` and attacking it offline — that is what the
/// Argon2id cost is for. Time is injected so the logic is unit-testable.
#[derive(Debug, Default)]
pub struct Throttle {
    failures: u32,
    blocked_until: Option<Instant>,
}

impl Throttle {
    /// `Err(remaining)` while attempts are blocked.
    pub fn check(&self, now: Instant) -> std::result::Result<(), Duration> {
        match self.blocked_until {
            Some(t) if t > now => Err(t - now),
            _ => Ok(()),
        }
    }

    pub fn record_failure(&mut self, now: Instant) {
        self.failures = self.failures.saturating_add(1);
        let d = throttle_delay(self.failures);
        self.blocked_until = if d.is_zero() { None } else { Some(now + d) };
    }

    pub fn record_success(&mut self) {
        *self = Self::default();
    }
}

// ─── Internals ───────────────────────────────────────────────────────────────

fn check_password(p: &str) -> Result<()> {
    if p.chars().count() < MIN_PASSWORD_LEN {
        return Err(VaultError::WeakPassword);
    }
    Ok(())
}

fn aad(label: &[u8], vault_id: &[u8]) -> Vec<u8> {
    let mut v = label.to_vec();
    v.extend_from_slice(vault_id);
    v
}

fn derive_kek(password: &str, salt: &[u8], p: &KdfParams) -> Result<VaultKey> {
    let params = Params::new(p.m_kib, p.t, p.p, Some(KEY_LEN)).map_err(|_| VaultError::BadMeta("kdf parameters"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(password.as_bytes(), salt, &mut *out)
        .map_err(|_| VaultError::Crypto)?;
    Ok(out)
}

fn wrap(kek: &[u8; KEY_LEN], aad: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new(Key::from_slice(kek));
    let ct = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: key, aad })
        .map_err(|_| VaultError::Crypto)?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ct);
    Ok(out)
}

fn unwrap(kek: &[u8; KEY_LEN], aad: &[u8], blob: &[u8]) -> Option<VaultKey> {
    if blob.len() != NONCE_LEN + KEY_LEN + 16 {
        return None;
    }
    let cipher = XChaCha20Poly1305::new(Key::from_slice(kek));
    let pt = Zeroizing::new(
        cipher
            .decrypt(XNonce::from_slice(&blob[..NONCE_LEN]), Payload { msg: &blob[NONCE_LEN..], aad })
            .ok()?,
    );
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    if pt.len() != KEY_LEN {
        return None;
    }
    key.copy_from_slice(&pt);
    Some(key)
}

// ─── Recovery-key text format (Crockford base32, groups of 4) ────────────────

pub fn format_recovery_key(key: &[u8; KEY_LEN]) -> String {
    let raw = b32_encode(key);
    raw.as_bytes()
        .chunks(4)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("-")
}

/// Tolerant parser: ignores case, dashes and whitespace; maps I/L→1, O→0.
pub fn parse_recovery_key(s: &str) -> Option<VaultKey> {
    let bytes = b32_decode(s)?;
    if bytes.len() != KEY_LEN {
        return None;
    }
    let mut k = Zeroizing::new([0u8; KEY_LEN]);
    k.copy_from_slice(&bytes);
    Some(k)
}

fn b32_encode(data: &[u8]) -> String {
    let mut out = String::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for &b in data {
        acc = (acc << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((acc >> bits) & 31) as usize] as char);
        }
        acc &= (1 << bits) - 1;
    }
    if bits > 0 {
        out.push(B32[((acc << (5 - bits)) & 31) as usize] as char);
    }
    out
}

fn b32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.chars() {
        if c == '-' || c.is_whitespace() {
            continue;
        }
        let c = match c.to_ascii_uppercase() {
            'I' | 'L' => '1',
            'O' => '0',
            x => x,
        };
        let v = B32.iter().position(|&a| a as char == c)? as u32;
        acc = (acc << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if acc != 0 {
        return None; // non-zero padding bits ⇒ not something we generated
    }
    Some(out)
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
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// Cheap KDF so the suite runs fast. Production uses `KdfParams::default()`.
    const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };
    const PW: &str = "correct horse battery";

    fn vault() -> (VaultMeta, VaultKey, String) {
        create_vault(PW, FAST).unwrap()
    }

    #[test]
    fn password_unlock_roundtrip() {
        let (meta, key, _) = vault();
        let k2 = unlock_with_password(&meta, PW).unwrap();
        assert_eq!(*key, *k2);
    }

    #[test]
    fn wrong_password_is_rejected() {
        let (meta, _, _) = vault();
        assert_eq!(unlock_with_password(&meta, "not the password").unwrap_err(), VaultError::WrongPassword);
    }

    #[test]
    fn weak_password_is_rejected() {
        assert_eq!(create_vault("short", FAST).unwrap_err(), VaultError::WeakPassword);
    }

    #[test]
    fn recovery_key_unlocks_and_is_format_tolerant() {
        let (meta, key, rec) = vault();
        assert_eq!(rec.len(), 52 + 12); // 52 chars + 12 dashes
        assert_eq!(*unlock_with_recovery(&meta, &rec).unwrap(), *key);
        let sloppy = rec.to_lowercase().replace('-', "  ");
        assert_eq!(*unlock_with_recovery(&meta, &sloppy).unwrap(), *key);
    }

    #[test]
    fn bad_recovery_key_is_rejected() {
        let (meta, _, rec) = vault();
        assert_eq!(unlock_with_recovery(&meta, "garbage!").unwrap_err(), VaultError::WrongRecoveryKey);
        // Valid format, wrong key.
        let (_, _, other) = vault();
        assert_eq!(unlock_with_recovery(&meta, &other).unwrap_err(), VaultError::WrongRecoveryKey);
        // One character off.
        let mut bad = rec.clone().into_bytes();
        bad[0] = if bad[0] == b'0' { b'1' } else { b'0' };
        assert_eq!(
            unlock_with_recovery(&meta, std::str::from_utf8(&bad).unwrap()).unwrap_err(),
            VaultError::WrongRecoveryKey
        );
    }

    #[test]
    fn change_password_keeps_key_and_recovery() {
        let (meta, key, rec) = vault();
        let meta2 = rewrap_password(&meta, &key, "a brand new password").unwrap();
        assert_ne!(meta.salt, meta2.salt);
        assert_eq!(unlock_with_password(&meta2, PW).unwrap_err(), VaultError::WrongPassword);
        assert_eq!(*unlock_with_password(&meta2, "a brand new password").unwrap(), *key);
        assert_eq!(*unlock_with_recovery(&meta2, &rec).unwrap(), *key);
    }

    #[test]
    fn recovery_can_reset_password() {
        let (meta, key, rec) = vault();
        let k = unlock_with_recovery(&meta, &rec).unwrap();
        let meta2 = rewrap_password(&meta, &k, "forgot and reset it").unwrap();
        assert_eq!(*unlock_with_password(&meta2, "forgot and reset it").unwrap(), *key);
    }

    #[test]
    fn seal_open_roundtrip() {
        let (meta, key, _) = vault();
        let id = meta.vault_id_bytes().unwrap();
        for text in ["", "hello", "नमस्ते 🔒 — unicode ✓", &"x".repeat(1_000_000)] {
            let file = seal(&key, &id, "md", text.as_bytes()).unwrap();
            assert_eq!(&file[..4], b"NQV1");
            let (ext, pt) = open(&key, &id, &file).unwrap();
            assert_eq!(ext, "md");
            assert_eq!(&pt[..], text.as_bytes());
        }
    }

    #[test]
    fn ciphertext_never_contains_plaintext() {
        let (meta, key, _) = vault();
        let id = meta.vault_id_bytes().unwrap();
        let secret = b"TOP-SECRET-MARKER-12345";
        let file = seal(&key, &id, "txt", secret).unwrap();
        assert!(!file.windows(secret.len()).any(|w| w == secret));
    }

    #[test]
    fn every_seal_uses_a_fresh_nonce() {
        let (meta, key, _) = vault();
        let id = meta.vault_id_bytes().unwrap();
        let a = seal(&key, &id, "md", b"same").unwrap();
        let b = seal(&key, &id, "md", b"same").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn tampering_anywhere_is_detected() {
        let (meta, key, _) = vault();
        let id = meta.vault_id_bytes().unwrap();
        let file = seal(&key, &id, "md", b"important note").unwrap();
        // Flip each byte after the magic/version/vault-id prefix in turn
        // (ext length, ext, nonce, ciphertext, tag) — none may decrypt.
        for i in (5 + VAULT_ID_LEN)..file.len() {
            let mut bad = file.clone();
            bad[i] ^= 0x01;
            assert!(open(&key, &id, &bad).is_err(), "byte {i} tamper went undetected");
        }
    }

    #[test]
    fn truncation_and_garbage_are_rejected() {
        let (meta, key, _) = vault();
        let id = meta.vault_id_bytes().unwrap();
        let file = seal(&key, &id, "md", b"abc").unwrap();
        assert!(matches!(open(&key, &id, &file[..10]), Err(VaultError::Corrupt(_))));
        assert!(open(&key, &id, &file[..file.len() - 1]).is_err());
        let mut bad_magic = file.clone();
        bad_magic[0] = b'X';
        assert_eq!(open(&key, &id, &bad_magic).unwrap_err(), VaultError::Corrupt("not a .nqv file"));
        let mut bad_ver = file.clone();
        bad_ver[4] = 9;
        assert_eq!(open(&key, &id, &bad_ver).unwrap_err(), VaultError::UnsupportedVersion(9));
    }

    #[test]
    fn file_from_another_vault_is_flagged() {
        let (m1, k1, _) = vault();
        let (m2, k2, _) = vault();
        let id1 = m1.vault_id_bytes().unwrap();
        let id2 = m2.vault_id_bytes().unwrap();
        let file = seal(&k1, &id1, "md", b"x").unwrap();
        assert_eq!(open(&k2, &id2, &file).unwrap_err(), VaultError::VaultMismatch);
    }

    #[test]
    fn wrong_key_fails_authentication() {
        let (meta, key, _) = vault();
        let id = meta.vault_id_bytes().unwrap();
        let file = seal(&key, &id, "md", b"x").unwrap();
        let mut other = key.clone();
        other[0] ^= 1;
        assert_eq!(open(&other, &id, &file).unwrap_err(), VaultError::Tampered);
    }

    #[test]
    fn invalid_extensions_are_refused() {
        let (meta, key, _) = vault();
        let id = meta.vault_id_bytes().unwrap();
        assert!(seal(&key, &id, "../x", b"").is_err());
        assert!(seal(&key, &id, &"a".repeat(MAX_EXT_LEN + 1), b"").is_err());
        assert!(seal(&key, &id, "", b"").is_ok());
    }

    #[test]
    fn meta_json_roundtrip_and_validation() {
        let (meta, _, _) = vault();
        let json = meta.to_json();
        assert!(!json.contains(PW));
        assert_eq!(VaultMeta::from_json(&json).unwrap(), meta);

        let mut evil = meta.clone();
        evil.kdf.m_kib = u32::MAX;
        assert!(VaultMeta::from_json(&evil.to_json()).is_err());
        assert!(VaultMeta::from_json("{").is_err());
    }

    #[test]
    fn swapping_wraps_between_vaults_fails() {
        // pw_wrap is bound to vault_id via AAD: grafting vault A's wrap into
        // vault B's metadata must not unlock.
        let (a, _, _) = vault();
        let (mut b, _, _) = vault();
        b.pw_wrap = a.pw_wrap.clone();
        b.salt = a.salt.clone();
        assert_eq!(unlock_with_password(&b, PW).unwrap_err(), VaultError::WrongPassword);
    }

    #[test]
    fn throttle_delay_schedule() {
        let secs = |n| throttle_delay(n).as_secs();
        assert_eq!((secs(0), secs(1), secs(2)), (0, 0, 0));
        assert_eq!((secs(3), secs(4), secs(5), secs(6)), (2, 4, 8, 16));
        assert_eq!((secs(7), secs(8)), (32, 60));
        assert_eq!(secs(9), 60);
        assert_eq!(secs(u32::MAX), 60); // no overflow / panic
    }

    #[test]
    fn throttle_blocks_then_releases_and_resets() {
        let t0 = Instant::now();
        let mut t = Throttle::default();
        t.record_failure(t0);
        t.record_failure(t0);
        assert!(t.check(t0).is_ok()); // still within free attempts
        t.record_failure(t0); // 3rd failure → 2s block
        let remaining = t.check(t0).unwrap_err();
        assert_eq!(remaining, Duration::from_secs(2));
        assert!(t.check(t0 + Duration::from_secs(1)).is_err());
        assert!(t.check(t0 + Duration::from_secs(2)).is_ok());
        t.record_failure(t0 + Duration::from_secs(2)); // 4th → 4s
        assert_eq!(t.check(t0 + Duration::from_secs(2)).unwrap_err(), Duration::from_secs(4));
        t.record_success();
        assert!(t.check(t0 + Duration::from_secs(2)).is_ok());
        t.record_failure(t0); // counter restarted → free again
        assert!(t.check(t0).is_ok());
    }

    #[test]
    fn base32_roundtrip() {
        for len in [0usize, 1, 5, 31, 32, 33] {
            let data: Vec<u8> = (0..len as u8).map(|i| i.wrapping_mul(37).wrapping_add(11)).collect();
            assert_eq!(b32_decode(&b32_encode(&data)).unwrap(), data, "len {len}");
        }
        assert!(b32_decode("U").is_none()); // 'U' is not in the alphabet
    }
}
