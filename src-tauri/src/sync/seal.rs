//! Vault Sync P3: how objects are sealed for the remote store.
//!
//! Remote layout (see `design/vault-sync-plan.md` → "Remote layout"):
//!
//! ```text
//! vault.meta              "NQM1" | json_len u32 BE | VaultMeta JSON | envelope(Meta, gen, "vault.meta", sha256(json))
//! devices/<deviceId>.nqs  envelope(Snapshot, gen, deviceId, JSON Snapshot { db without attachment data, … })
//! blobs/<opaque>          envelope(Blob, 0, attachmentId, raw attachment bytes)
//! ```
//!
//! Envelope: `"NQS1" | kind u8 | generation u64 BE | vault_id[16] | subject_len u8 | subject |
//! nonce[24] | ciphertext+tag`; the whole header before the nonce is the AEAD associated data, so
//! an object can't be moved to another vault, kind, device/attachment or generation without
//! failing authentication. The AEAD key is an HKDF-SHA256 subkey of the vault key (never the
//! vault key itself), separate from the subkey that names blobs.
//!
//! `vault.meta` must be readable BEFORE the key is known (a new device needs its KDF params and
//! password wrap), so its JSON is stored in the clear (it holds only wrapped keys, exactly like
//! the local `vault.json`) and authenticated by an envelope over its SHA-256 once the key is
//! unwrapped: a swapped/rolled-back/foreign meta is detected after unlock.

use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::vault_core::{self as vc, VaultKey, VaultMeta, KEY_LEN, NONCE_LEN, VAULT_ID_LEN};
use crate::vault_db::{Db, DB_VERSION};

pub const META_NAME: &str = "vault.meta";
pub const DEVICES_PREFIX: &str = "devices/";
pub const DEVICE_SUFFIX: &str = ".nqs";
pub const BLOBS_PREFIX: &str = "blobs/";

const ENV_MAGIC: &[u8; 4] = b"NQS1";
const META_MAGIC: &[u8; 4] = b"NQM1";
const MAX_META_JSON: usize = 64 * 1024;
const HKDF_SALT: &[u8] = b"notiq-vault-sync-v1";
const SNAPSHOT_FORMAT: u32 = 1;

/// What an envelope holds (part of the associated data).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Meta = 1,
    Snapshot = 2,
    Blob = 3,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SealError {
    /// Not an object of the expected format/kind.
    Format(&'static str),
    /// Sealed for another vault.
    OtherVault,
    /// Another device's / attachment's object stored under this name.
    WrongSubject,
    /// Authentication failed (wrong key or modified).
    Tampered,
}

impl std::fmt::Display for SealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SealError::Format(m) => write!(f, "unreadable sync object ({m})"),
            SealError::OtherVault => f.write_str("the sync object belongs to another vault"),
            SealError::WrongSubject => f.write_str("the sync object was stored under the wrong name"),
            SealError::Tampered => f.write_str("the sync object couldn't be verified (modified or wrong key)"),
        }
    }
}

/// Subkeys derived from the vault key.
pub struct SyncKeys {
    seal: Zeroizing<[u8; KEY_LEN]>,
    names: Zeroizing<[u8; KEY_LEN]>,
    vault_id: [u8; VAULT_ID_LEN],
}

impl SyncKeys {
    pub fn derive(key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN]) -> SyncKeys {
        let hk = Hkdf::<Sha256>::new(Some(HKDF_SALT), &key[..]);
        let sub = |label: &[u8]| {
            let mut info = label.to_vec();
            info.extend_from_slice(vault_id);
            let mut out = Zeroizing::new([0u8; KEY_LEN]);
            hk.expand(&info, &mut *out).expect("32 bytes is a valid HKDF-SHA256 length");
            out
        };
        SyncKeys { seal: sub(b"seal"), names: sub(b"blob-names"), vault_id: *vault_id }
    }

    pub fn vault_id(&self) -> &[u8; VAULT_ID_LEN] {
        &self.vault_id
    }

    /// `blobs/<32 hex>`: a keyed hash (HKDF-Expand = HMAC-SHA256) of the attachment id, so the
    /// name says nothing about the attachment and is the same on every device.
    pub fn blob_name(&self, attachment_id: &str) -> String {
        let hk = Hkdf::<Sha256>::from_prk(&self.names[..]).expect("32-byte PRK");
        let mut out = [0u8; 16];
        hk.expand(attachment_id.as_bytes(), &mut out).expect("16 bytes is a valid length");
        format!("{BLOBS_PREFIX}{}", hex(&out))
    }

    fn header(&self, kind: Kind, generation: u64, subject: &str) -> Vec<u8> {
        let mut h = Vec::with_capacity(4 + 1 + 8 + VAULT_ID_LEN + 1 + subject.len());
        h.extend_from_slice(ENV_MAGIC);
        h.push(kind as u8);
        h.extend_from_slice(&generation.to_be_bytes());
        h.extend_from_slice(&self.vault_id);
        h.push(subject.len() as u8);
        h.extend_from_slice(subject.as_bytes());
        h
    }

    /// Seals `payload` into an envelope bound to (vault, kind, generation, subject).
    pub fn seal(&self, kind: Kind, generation: u64, subject: &str, payload: &[u8]) -> Vec<u8> {
        assert!(subject.len() <= u8::MAX as usize, "subject too long");
        let mut out = self.header(kind, generation, subject);
        let body = vc::seal_aad(&self.seal, &out, payload).expect("XChaCha20-Poly1305 sealing does not fail");
        out.extend_from_slice(&body);
        out
    }

    /// Opens an envelope that must be of `kind` for `subject`; returns (generation, payload).
    pub fn open(&self, kind: Kind, subject: &str, data: &[u8]) -> Result<(u64, Zeroizing<Vec<u8>>), SealError> {
        let h = parse_header(data)?;
        if h.kind != kind as u8 {
            return Err(SealError::Format("unexpected object kind"));
        }
        if h.vault_id != self.vault_id {
            return Err(SealError::OtherVault);
        }
        if h.subject != subject.as_bytes() {
            return Err(SealError::WrongSubject);
        }
        let plain = vc::open_aad(&self.seal, &data[..h.len], &data[h.len..]).map_err(|_| SealError::Tampered)?;
        Ok((h.generation, plain))
    }
}

struct Header<'a> {
    kind: u8,
    generation: u64,
    vault_id: [u8; VAULT_ID_LEN],
    subject: &'a [u8],
    len: usize,
}

fn parse_header(data: &[u8]) -> Result<Header<'_>, SealError> {
    let fixed = 4 + 1 + 8 + VAULT_ID_LEN + 1;
    if data.len() < fixed + NONCE_LEN + 16 || &data[..4] != ENV_MAGIC {
        return Err(SealError::Format("not a sync object"));
    }
    let generation = u64::from_be_bytes(data[5..13].try_into().expect("8 bytes"));
    let vault_id: [u8; VAULT_ID_LEN] = data[13..13 + VAULT_ID_LEN].try_into().expect("16 bytes");
    let slen = data[fixed - 1] as usize;
    if data.len() < fixed + slen + NONCE_LEN + 16 {
        return Err(SealError::Format("truncated"));
    }
    Ok(Header { kind: data[4], generation, vault_id, subject: &data[fixed..fixed + slen], len: fixed + slen })
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn vault_id_hex(id: &[u8; VAULT_ID_LEN]) -> String {
    hex(id)
}

// ─── names ───────────────────────────────────────────────────────────────────

pub fn device_object(device_id: &str) -> String {
    format!("{DEVICES_PREFIX}{device_id}{DEVICE_SUFFIX}")
}

/// `devices/<id>.nqs` → `<id>` (only well-formed device ids).
pub fn device_from_object(name: &str) -> Option<&str> {
    let id = name.strip_prefix(DEVICES_PREFIX)?.strip_suffix(DEVICE_SUFFIX)?;
    crate::vault_hlc::valid_device_id(id).then_some(id)
}

// ─── vault.meta ──────────────────────────────────────────────────────────────

/// A `vault.meta` read from the store, not yet authenticated.
#[derive(Debug, Clone)]
pub struct RemoteMeta {
    pub meta: VaultMeta,
    pub generation: u64,
    json: Vec<u8>,
    envelope: Vec<u8>,
}

impl RemoteMeta {
    /// Parses the clear part. Nothing is trusted until [`RemoteMeta::verify`] passes.
    pub fn parse(data: &[u8]) -> Result<RemoteMeta, SealError> {
        if data.len() < 8 || &data[..4] != META_MAGIC {
            return Err(SealError::Format("not a vault.meta"));
        }
        let n = u32::from_be_bytes(data[4..8].try_into().expect("4 bytes")) as usize;
        if n == 0 || n > MAX_META_JSON || data.len() < 8 + n {
            return Err(SealError::Format("bad vault.meta length"));
        }
        let json = data[8..8 + n].to_vec();
        let meta = std::str::from_utf8(&json)
            .ok()
            .and_then(|s| VaultMeta::from_json(s).ok())
            .ok_or(SealError::Format("invalid vault.meta content"))?;
        let envelope = data[8 + n..].to_vec();
        let h = parse_header(&envelope)?;
        if h.kind != Kind::Meta as u8 {
            return Err(SealError::Format("unexpected object kind"));
        }
        Ok(RemoteMeta { meta, generation: h.generation, json, envelope })
    }

    /// Authenticates the meta (and its generation) with the vault key it wraps.
    pub fn verify(&self, keys: &SyncKeys) -> Result<(), SealError> {
        let (gen, digest) = keys.open(Kind::Meta, META_NAME, &self.envelope)?;
        if gen != self.generation || digest.as_slice() != Sha256::digest(&self.json).as_slice() {
            return Err(SealError::Tampered);
        }
        if self.meta.vault_id_bytes().map_err(|_| SealError::Format("vault id"))? != *keys.vault_id() {
            return Err(SealError::OtherVault);
        }
        Ok(())
    }

    /// The meta's vault id (from the clear part).
    pub fn vault_id(&self) -> Option<[u8; VAULT_ID_LEN]> {
        self.meta.vault_id_bytes().ok()
    }
}

/// Builds `vault.meta` for `meta` at `generation`.
pub fn seal_meta(keys: &SyncKeys, meta: &VaultMeta, generation: u64) -> Vec<u8> {
    let json = meta.to_json().into_bytes();
    let mut out = META_MAGIC.to_vec();
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(&keys.seal(Kind::Meta, generation, META_NAME, &Sha256::digest(&json)));
    out
}

// ─── device snapshots ────────────────────────────────────────────────────────

/// One device's state: its whole database with attachment DATA moved out to blobs.
#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub format: u32,
    pub device_id: String,
    pub device_name: String,
    pub written_at_ms: u64,
    pub generation: u64,
    pub db: Db,
}

/// A copy of `db` without attachment data (the snapshot form).
pub fn strip_attachment_data(db: &Db) -> Db {
    let mut out = db.clone();
    for e in out.entries.values_mut() {
        for a in e.attachments.iter_mut() {
            zeroize::Zeroize::zeroize(&mut a.data);
            a.data = String::new();
        }
    }
    out
}

pub fn seal_snapshot(keys: &SyncKeys, snap: &Snapshot) -> Result<Vec<u8>, String> {
    let json = Zeroizing::new(serde_json::to_vec(snap).map_err(|e| e.to_string())?);
    Ok(keys.seal(Kind::Snapshot, snap.generation, &snap.device_id, &json))
}

/// Opens `devices/<device_id>.nqs`. The envelope's subject, the payload's device id and both
/// generations must agree.
pub fn open_snapshot(keys: &SyncKeys, device_id: &str, data: &[u8]) -> Result<Snapshot, SealError> {
    let (gen, plain) = keys.open(Kind::Snapshot, device_id, data)?;
    let mut s: Snapshot = serde_json::from_slice(&plain).map_err(|_| SealError::Format("invalid snapshot"))?;
    if s.format > SNAPSHOT_FORMAT {
        return Err(SealError::Format("snapshot from a newer Notiq"));
    }
    if s.device_id != device_id || s.generation != gen {
        return Err(SealError::WrongSubject);
    }
    s.db.loaded_v = s.db.v;
    s.db.v = DB_VERSION;
    s.db.normalise();
    Ok(s)
}

pub fn new_snapshot(device_id: &str, device_name: &str, now_ms: u64, generation: u64, db: Db) -> Snapshot {
    Snapshot { format: SNAPSHOT_FORMAT, device_id: device_id.into(), device_name: device_name.into(), written_at_ms: now_ms, generation, db }
}

// ─── blobs ───────────────────────────────────────────────────────────────────

pub fn seal_blob(keys: &SyncKeys, attachment_id: &str, bytes: &[u8]) -> Vec<u8> {
    keys.seal(Kind::Blob, 0, attachment_id, bytes)
}

pub fn open_blob(keys: &SyncKeys, attachment_id: &str, data: &[u8]) -> Result<Zeroizing<Vec<u8>>, SealError> {
    keys.open(Kind::Blob, attachment_id, data).map(|(_, p)| p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_core::{create_vault, KdfParams};

    const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };
    const DEV_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const DEV_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn keys() -> (VaultMeta, VaultKey, SyncKeys) {
        let (meta, key, _) = create_vault("a-long-test-password", FAST).unwrap();
        let k = SyncKeys::derive(&key, &meta.vault_id_bytes().unwrap());
        (meta, key, k)
    }

    #[test]
    fn envelope_binds_kind_subject_vault_and_generation() {
        let (_, _, k) = keys();
        let obj = k.seal(Kind::Snapshot, 7, DEV_A, b"hello");
        let (gen, p) = k.open(Kind::Snapshot, DEV_A, &obj).unwrap();
        assert_eq!((gen, &p[..]), (7, &b"hello"[..]));
        assert_eq!(k.open(Kind::Snapshot, DEV_B, &obj).unwrap_err(), SealError::WrongSubject);
        assert!(matches!(k.open(Kind::Blob, DEV_A, &obj), Err(SealError::Format(_))));
        // Rewriting the generation in the header breaks authentication.
        let mut regen = obj.clone();
        regen[12] ^= 1;
        assert_eq!(k.open(Kind::Snapshot, DEV_A, &regen).unwrap_err(), SealError::Tampered);
        // Another vault's key can't open it and it is flagged as foreign.
        let (_, _, other) = keys();
        assert_eq!(other.open(Kind::Snapshot, DEV_A, &obj).unwrap_err(), SealError::OtherVault);
        for i in 0..obj.len() {
            let mut bad = obj.clone();
            bad[i] ^= 0x10;
            assert!(k.open(Kind::Snapshot, DEV_A, &bad).is_err(), "byte {i}");
        }
    }

    #[test]
    fn plaintext_never_appears_in_objects_or_names() {
        let (_, _, k) = keys();
        let secret = b"TOP-SECRET-MARKER";
        let obj = k.seal(Kind::Blob, 0, "att1", secret);
        assert!(!obj.windows(secret.len()).any(|w| w == secret));
        let n = k.blob_name("att1");
        assert!(n.starts_with(BLOBS_PREFIX) && !n.contains("att1") && n.len() == BLOBS_PREFIX.len() + 32);
        assert_eq!(n, k.blob_name("att1"));
        assert_ne!(n, k.blob_name("att2"));
        let (_, _, other) = keys();
        assert_ne!(n, other.blob_name("att1"), "names are keyed per vault");
        assert!(crate::sync::provider::validate_name(&n).is_ok());
    }

    #[test]
    fn meta_roundtrip_and_tamper_detection() {
        let (meta, _, k) = keys();
        let obj = seal_meta(&k, &meta, 3);
        let rm = RemoteMeta::parse(&obj).unwrap();
        assert_eq!((rm.generation, &rm.meta), (3, &meta));
        rm.verify(&k).unwrap();
        // Claiming a higher generation in the header is caught after unlock.
        let mut bumped = obj.clone();
        let env_start = obj.len() - (rm.envelope.len());
        bumped[env_start + 12] ^= 1;
        assert!(RemoteMeta::parse(&bumped).unwrap().verify(&k).is_err());
        // Editing the clear JSON (e.g. weaker KDF) is caught too.
        let mut weaker = meta.clone();
        weaker.kdf.t = 2;
        let mut forged = META_MAGIC.to_vec();
        let j = weaker.to_json().into_bytes();
        forged.extend_from_slice(&(j.len() as u32).to_be_bytes());
        forged.extend_from_slice(&j);
        forged.extend_from_slice(&rm.envelope);
        assert_eq!(RemoteMeta::parse(&forged).unwrap().verify(&k).unwrap_err(), SealError::Tampered);
        // Another vault's meta never verifies with our key.
        let (m2, _, k2) = keys();
        assert!(RemoteMeta::parse(&seal_meta(&k2, &m2, 1)).unwrap().verify(&k).is_err());
        assert!(RemoteMeta::parse(b"garbage").is_err());
    }

    #[test]
    fn snapshot_roundtrip_strips_attachment_data() {
        let (_, _, k) = keys();
        let mut db = Db::new();
        db.device = DEV_A.into();
        db.put("a.nqv", "md", "body").unwrap();
        db.attach_add("a.nqv", "x.txt", &crate::vault_db::b64_encode(b"data")).unwrap();
        let stripped = strip_attachment_data(&db);
        assert!(stripped.entries.values().all(|e| e.attachments.iter().all(|a| a.data.is_empty())));
        let snap = new_snapshot(DEV_A, "Laptop", 5, 2, stripped);
        let obj = seal_snapshot(&k, &snap).unwrap();
        let back = open_snapshot(&k, DEV_A, &obj).unwrap();
        assert_eq!((back.generation, back.device_name.as_str()), (2, "Laptop"));
        assert_eq!(back.db.get("a.nqv").unwrap().content, "body");
        // B's name on A's snapshot is rejected.
        assert_eq!(open_snapshot(&k, DEV_B, &obj).unwrap_err(), SealError::WrongSubject);
    }

    #[test]
    fn device_names() {
        assert_eq!(device_object(DEV_A), format!("devices/{DEV_A}.nqs"));
        assert_eq!(device_from_object(&device_object(DEV_A)), Some(DEV_A));
        assert_eq!(device_from_object("devices/nothex.nqs"), None);
        assert_eq!(device_from_object("blobs/abc"), None);
    }
}
