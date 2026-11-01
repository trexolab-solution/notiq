//! Passkeys (WebAuthn, experimental): the authenticator side of the browser extension's passkey support.
//!
//! Pure module (no Tauri): request validation, the WebAuthn RP ID rule, ES256 key generation and signing
//! (`ring`, already in the dependency tree), and the byte encodings a relying party verifies
//! (authenticatorData, COSE key, CBOR attestation object with `fmt: "none"`). The Tauri glue (approval
//! prompt, vault reads) lives in `autofill.rs` ("Passkeys" block); the prompt window writes the new
//! credential into the vault (`src/lib/passkeys.ts`).
//!
//! Storage: a passkey is kept on the matching Login entry, in its JSON `passkeys` list:
//! `{rpId, credentialId, userHandle, userName, displayName, rpName, key, alg, created}` where `key` is the
//! PKCS#8 DER private key (base64url) and ids are base64url without padding. The private key never leaves
//! the app: the extension only gets public data, signatures and attestation objects.
//!
//! Flags: UP and UV are always set (the user approved in Notiq, which needs the unlocked vault: the master
//! password or Windows Hello). BE and BS are set: the key lives in the vault file, which the user may back up
//! or sync. AAGUID is all zeros (attestation "none": no authenticator model is claimed). signCount stays 0.

use std::collections::HashSet;
use std::sync::OnceLock;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

/// COSE algorithm id of ES256 (ECDSA P-256 with SHA-256), the only one supported.
pub const ES256: i64 = -7;
pub const FLAG_UP: u8 = 0x01;
pub const FLAG_UV: u8 = 0x04;
pub const FLAG_BE: u8 = 0x08;
pub const FLAG_BS: u8 = 0x10;
pub const FLAG_AT: u8 = 0x40;
/// Flags of every authenticatorData this authenticator produces (AT is added on registration).
pub const FLAGS: u8 = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS;
/// No authenticator model is claimed (attestation "none").
pub const AAGUID: [u8; 16] = [0; 16];
/// Length of a new credential id (random bytes).
pub const CRED_ID_LEN: usize = 16;

const MAX_ID_BYTES: usize = 1023; // WebAuthn's limit for a credential id
const MAX_USER_ID: usize = 64; // WebAuthn's limit for user.id
const MAX_CHALLENGE: usize = 1024;
const MAX_CLIENT_DATA: usize = 4096;
const MAX_LIST: usize = 64;
const MAX_NAME: usize = 256;

/// DER prefix of a P-256 SubjectPublicKeyInfo; followed by the 65-byte uncompressed point.
const SPKI_P256_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
    0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

// ─── base64url ───────────────────────────────────────────────────────────────

pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Strict base64url without padding (what the extension sends); `None` for anything else.
pub fn b64u_decode(s: &str) -> Option<Vec<u8>> {
    if s.bytes().any(|b| !(b.is_ascii_alphanumeric() || b == b'-' || b == b'_')) {
        return None;
    }
    URL_SAFE_NO_PAD.decode(s).ok()
}

// ─── Public Suffix List (the app's own table, shared with the TS side) ───────

struct Psl {
    rules: HashSet<String>,
    wildcard: HashSet<String>,
    exception: HashSet<String>,
}

/// Every `"..."` string between `start` and the next `end` marker.
fn quoted_in(src: &str, start: &str, end: &str) -> Vec<String> {
    let Some(a) = src.find(start) else { return vec![] };
    let rest = &src[a + start.len()..];
    let body = &rest[..rest.find(end).unwrap_or(rest.len())];
    body.split('"').skip(1).step_by(2).map(str::to_string).collect()
}

fn psl() -> &'static Psl {
    static P: OnceLock<Psl> = OnceLock::new();
    P.get_or_init(|| {
        let src = include_str!("../../src/lib/publicSuffixData.ts");
        let mut rules: HashSet<String> = quoted_in(src, "export const EXTRA", "];").into_iter().collect();
        if let Some(a) = src.find("export const SECOND_LEVEL") {
            let rest = &src[a..];
            let body = &rest[rest.find('{').map_or(0, |i| i + 1)..rest.find("};").unwrap_or(rest.len())];
            for line in body.lines() {
                let Some((tld, list)) = line.split_once(':') else { continue };
                let tld = tld.trim().trim_matches('"');
                if tld.is_empty() || tld.starts_with("//") {
                    continue;
                }
                for l in list.trim().trim_end_matches(',').trim_matches('"').split(' ').filter(|l| !l.is_empty()) {
                    rules.insert(format!("{l}.{tld}"));
                }
            }
        }
        Psl {
            rules,
            wildcard: quoted_in(src, "export const WILDCARD", "];").into_iter().collect(),
            exception: quoted_in(src, "export const EXCEPTION", "];").into_iter().collect(),
        }
    })
}

/// An IPv4-looking or IPv6 host (never a valid RP ID).
fn is_ip(host: &str) -> bool {
    host.contains(':') || host.starts_with('[') || host.bytes().all(|b| b.is_ascii_digit() || b == b'.')
}

/// The public suffix of `host` (`www.bbc.co.uk` → `co.uk`); same algorithm as `src/lib/publicSuffix.ts`.
pub fn public_suffix(host: &str) -> String {
    let p = psl();
    let is_rule = |name: &str| {
        if name.is_empty() || p.exception.contains(name) {
            return false;
        }
        if !name.contains('.') || p.rules.contains(name) {
            return true;
        }
        name.split_once('.').is_some_and(|(_, parent)| p.wildcard.contains(parent))
    };
    let labels: Vec<&str> = host.split('.').collect();
    for i in 0..labels.len() {
        let cand = labels[i..].join(".");
        if p.exception.contains(&cand) {
            return cand.split_once('.').map(|(_, s)| s.to_string()).unwrap_or_default();
        }
        if is_rule(&cand) {
            return cand;
        }
    }
    labels.last().map(|s| s.to_string()).unwrap_or_default()
}

/// A plain DNS host name: lower-case letters, digits, dashes and dots, no empty label, 1..=253 chars.
fn valid_dns_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.split('.').all(|l| !l.is_empty() && l.len() <= 63 && !l.starts_with('-') && !l.ends_with('-'))
        && h.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'.')
}

/// The WebAuthn RP ID rule: `rp_id` must equal the origin's host, or be a registrable domain suffix of it
/// (a parent domain that is not itself a public suffix: `github.com` for `www.github.com`, never `com`,
/// `co.uk` or `github.io`). IP addresses never qualify; `localhost` only as itself.
pub fn rp_id_valid(rp_id: &str, origin_host: &str) -> bool {
    if !valid_dns_host(rp_id) || !valid_dns_host(origin_host) || is_ip(rp_id) || is_ip(origin_host) {
        return false;
    }
    if rp_id == origin_host {
        // A bare public suffix (`com`, `github.io`) can't be an RP; `localhost` is the one single-label host allowed.
        return rp_id == "localhost" || public_suffix(rp_id) != rp_id;
    }
    if origin_host == "localhost" || origin_host.ends_with(".localhost") || rp_id == "localhost" {
        return false;
    }
    origin_host.ends_with(&format!(".{rp_id}")) && public_suffix(rp_id) != rp_id
}

/// `https://host[:port]` (or `http://localhost[:port]`) → host. Anything else (a path, credentials, IPs, other
/// schemes, upper case) is refused: WebAuthn needs a secure context and a domain.
pub fn origin_host(origin: &str) -> Result<String, &'static str> {
    if origin.len() > 300 {
        return Err("bad_request");
    }
    let (rest, https) = match origin.strip_prefix("https://") {
        Some(r) => (r, true),
        None => (origin.strip_prefix("http://").ok_or("not_https")?, false),
    };
    let (host, port) = match rest.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (rest, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return Err("bad_request");
        }
    }
    if !valid_dns_host(host) || is_ip(host) {
        return Err("bad_host");
    }
    if !https && host != "localhost" {
        return Err("not_https");
    }
    Ok(host.to_string())
}

// ─── CBOR (just what attestation needs: canonical, definite lengths) ─────────

fn cbor_head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend_from_slice(&[m | 24, n as u8]),
        0x100..=0xffff => {
            out.push(m | 25);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(m | 26);
            out.extend_from_slice(&(n as u32).to_be_bytes());
        }
        _ => {
            out.push(m | 27);
            out.extend_from_slice(&n.to_be_bytes());
        }
    }
}

pub fn cbor_int(out: &mut Vec<u8>, v: i64) {
    if v >= 0 {
        cbor_head(out, 0, v as u64);
    } else {
        cbor_head(out, 1, (-1 - v) as u64);
    }
}

pub fn cbor_bytes(out: &mut Vec<u8>, b: &[u8]) {
    cbor_head(out, 2, b.len() as u64);
    out.extend_from_slice(b);
}

pub fn cbor_text(out: &mut Vec<u8>, s: &str) {
    cbor_head(out, 3, s.len() as u64);
    out.extend_from_slice(s.as_bytes());
}

pub fn cbor_map_head(out: &mut Vec<u8>, entries: u64) {
    cbor_head(out, 5, entries);
}

/// COSE_Key of an ES256 public key: `{1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}` in CTAP2
/// canonical key order.
pub fn cose_es256(x: &[u8; 32], y: &[u8; 32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(77);
    cbor_map_head(&mut out, 5);
    cbor_int(&mut out, 1);
    cbor_int(&mut out, 2);
    cbor_int(&mut out, 3);
    cbor_int(&mut out, ES256);
    cbor_int(&mut out, -1);
    cbor_int(&mut out, 1);
    cbor_int(&mut out, -2);
    cbor_bytes(&mut out, x);
    cbor_int(&mut out, -3);
    cbor_bytes(&mut out, y);
    out
}

/// authenticatorData: `SHA-256(rpId) ‖ flags ‖ signCount (u32 BE) ‖ [AAGUID ‖ len(credId) u16 BE ‖ credId ‖ COSE key]`.
/// The attested credential data (and the AT flag) is present only on registration.
pub fn authenticator_data(rp_id: &str, flags: u8, sign_count: u32, attested: Option<(&[u8], &[u8])>) -> Vec<u8> {
    let mut out = Vec::with_capacity(37 + attested.map_or(0, |(c, k)| 18 + c.len() + k.len()));
    out.extend_from_slice(&Sha256::digest(rp_id.as_bytes()));
    out.push(if attested.is_some() { flags | FLAG_AT } else { flags & !FLAG_AT });
    out.extend_from_slice(&sign_count.to_be_bytes());
    if let Some((cred_id, cose_key)) = attested {
        out.extend_from_slice(&AAGUID);
        out.extend_from_slice(&(cred_id.len() as u16).to_be_bytes());
        out.extend_from_slice(cred_id);
        out.extend_from_slice(cose_key);
    }
    out
}

/// attestationObject with `fmt: "none"`: `{"fmt": "none", "attStmt": {}, "authData": bytes}` (canonical order).
pub fn attestation_object_none(auth_data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(auth_data.len() + 32);
    cbor_map_head(&mut out, 3);
    cbor_text(&mut out, "fmt");
    cbor_text(&mut out, "none");
    cbor_text(&mut out, "attStmt");
    cbor_map_head(&mut out, 0);
    cbor_text(&mut out, "authData");
    cbor_bytes(&mut out, auth_data);
    out
}

/// SubjectPublicKeyInfo (DER) of an uncompressed P-256 point, for `getPublicKey()`.
pub fn spki_p256(point: &[u8; 65]) -> Vec<u8> {
    let mut out = SPKI_P256_PREFIX.to_vec();
    out.extend_from_slice(point);
    out
}

// ─── Requests from the extension ─────────────────────────────────────────────

fn clean_name(v: Option<&Value>) -> String {
    let s = v.and_then(|v| v.as_str()).unwrap_or("");
    s.chars().filter(|c| !c.is_control()).take(MAX_NAME).collect::<String>().trim().to_string()
}

fn id_field(v: Option<&Value>, max: usize) -> Result<Vec<u8>, &'static str> {
    let s = v.and_then(|v| v.as_str()).ok_or("bad_request")?;
    let b = b64u_decode(s).ok_or("bad_request")?;
    if b.is_empty() || b.len() > max {
        return Err("bad_request");
    }
    Ok(b)
}

fn id_list(v: Option<&Value>) -> Result<Vec<String>, &'static str> {
    match v {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::Array(a)) if a.len() <= MAX_LIST => {
            a.iter().map(|x| id_field(Some(x), MAX_ID_BYTES).map(|b| b64u(&b))).collect()
        }
        _ => Err("bad_request"),
    }
}

/// The client data the extension built (from the frame's real origin) must be for this very ceremony: the
/// right `type`, the request's `origin`, a challenge, and, for a same-site subframe (`crossOrigin: true`), a
/// `topOrigin` the RP ID is valid for as well. Returns SHA-256(clientDataJSON).
pub fn check_client_data(raw: &[u8], want_type: &str, origin: &str, rp_id: &str) -> Result<[u8; 32], &'static str> {
    if raw.is_empty() || raw.len() > MAX_CLIENT_DATA {
        return Err("bad_request");
    }
    let v: Value = serde_json::from_slice(raw).map_err(|_| "bad_request")?;
    let get = |k: &str| v.get(k).and_then(|x| x.as_str());
    if get("type") != Some(want_type) || get("origin") != Some(origin) {
        return Err("bad_origin");
    }
    let challenge = get("challenge").ok_or("bad_request")?;
    let c = b64u_decode(challenge).ok_or("bad_request")?;
    if c.is_empty() || c.len() > MAX_CHALLENGE {
        return Err("bad_request");
    }
    match v.get("crossOrigin") {
        None | Some(Value::Bool(false)) => {}
        Some(Value::Bool(true)) => {
            let top = origin_host(get("topOrigin").ok_or("bad_origin")?).map_err(|_| "bad_origin")?;
            if !rp_id_valid(rp_id, &top) {
                return Err("bad_rp_id");
            }
        }
        Some(_) => return Err("bad_request"),
    }
    Ok(Sha256::digest(raw).into())
}

/// A validated `passkey_create` request.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateReq {
    pub host: String,
    pub rp_id: String,
    pub rp_name: String,
    pub user_id: Vec<u8>,
    pub user_name: String,
    pub display_name: String,
    pub client_data_hash: [u8; 32],
    /// Credential ids (base64url) the RP already knows for this user: never create a second one.
    pub exclude: Vec<String>,
}

/// A validated `passkey_get` request.
#[derive(Debug, Clone, PartialEq)]
pub struct GetReq {
    pub host: String,
    pub rp_id: String,
    pub client_data_hash: [u8; 32],
    /// Credential ids (base64url) the RP accepts; empty = any of this RP's passkeys (discoverable).
    pub allow: Vec<String>,
}

fn origin_and_rp(req: &Value) -> Result<(String, String, String), &'static str> {
    let origin = req.get("origin").and_then(|v| v.as_str()).ok_or("bad_request")?;
    let host = origin_host(origin)?;
    let rp_id = req.get("rpId").and_then(|v| v.as_str()).ok_or("bad_request")?;
    if !rp_id_valid(rp_id, &host) {
        return Err("bad_rp_id");
    }
    Ok((origin.to_string(), host, rp_id.to_string()))
}

fn client_data(req: &Value) -> Result<Vec<u8>, &'static str> {
    id_field(req.get("clientDataJSON"), MAX_CLIENT_DATA)
}

/// `{op:"passkey_create", origin, rpId, rpName, user:{id, name, displayName}, clientDataJSON, algs, exclude}`.
pub fn validate_create(req: &Value) -> Result<CreateReq, &'static str> {
    let (origin, host, rp_id) = origin_and_rp(req)?;
    let algs = req.get("algs").and_then(|v| v.as_array()).ok_or("bad_request")?;
    if algs.len() > 16 {
        return Err("bad_request");
    }
    // An empty list means the RP accepts the defaults (ES256 among them).
    if !algs.is_empty() && !algs.iter().any(|a| a.as_i64() == Some(ES256)) {
        return Err("unsupported_alg");
    }
    let user = req.get("user").filter(|u| u.is_object()).ok_or("bad_request")?;
    let user_id = id_field(user.get("id"), MAX_USER_ID)?;
    let user_name = clean_name(user.get("name"));
    let display_name = clean_name(user.get("displayName"));
    let client_data_hash = check_client_data(&client_data(req)?, "webauthn.create", &origin, &rp_id)?;
    Ok(CreateReq {
        host,
        rp_name: clean_name(req.get("rpName")),
        rp_id,
        user_id,
        user_name,
        display_name,
        client_data_hash,
        exclude: id_list(req.get("exclude"))?,
    })
}

/// `{op:"passkey_get", origin, rpId, clientDataJSON, allow}`.
pub fn validate_get(req: &Value) -> Result<GetReq, &'static str> {
    let (origin, host, rp_id) = origin_and_rp(req)?;
    let client_data_hash = check_client_data(&client_data(req)?, "webauthn.get", &origin, &rp_id)?;
    Ok(GetReq { host, rp_id, client_data_hash, allow: id_list(req.get("allow"))? })
}

// ─── Keys, registration and assertion ────────────────────────────────────────

/// A freshly generated credential, before the user approved storing it.
pub struct NewCredential {
    pub credential_id: Vec<u8>,
    /// PKCS#8 DER of the private key.
    pub pkcs8: Zeroizing<Vec<u8>>,
    /// Uncompressed public point (0x04 ‖ x ‖ y).
    pub public_point: [u8; 65],
}

pub fn generate() -> Result<NewCredential, &'static str> {
    let rng = SystemRandom::new();
    let doc = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).map_err(|_| "failed")?;
    let pkcs8 = Zeroizing::new(doc.as_ref().to_vec());
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &pkcs8, &rng).map_err(|_| "failed")?;
    let public_point: [u8; 65] = pair.public_key().as_ref().try_into().map_err(|_| "failed")?;
    let mut credential_id = vec![0u8; CRED_ID_LEN];
    ring::rand::SecureRandom::fill(&rng, &mut credential_id).map_err(|_| "failed")?;
    Ok(NewCredential { credential_id, pkcs8, public_point })
}

impl NewCredential {
    fn xy(&self) -> ([u8; 32], [u8; 32]) {
        let mut x = [0u8; 32];
        let mut y = [0u8; 32];
        x.copy_from_slice(&self.public_point[1..33]);
        y.copy_from_slice(&self.public_point[33..65]);
        (x, y)
    }

    /// authenticatorData of the registration (UP, UV, BE, BS, AT; signCount 0).
    pub fn auth_data(&self, rp_id: &str) -> Vec<u8> {
        let (x, y) = self.xy();
        authenticator_data(rp_id, FLAGS, 0, Some((&self.credential_id, &cose_es256(&x, &y))))
    }

    /// The vault record for the prompt window to store on a Login entry (holds the private key).
    pub fn record(&self, req: &CreateReq, created_ms: u64) -> Value {
        json!({
            "rpId": req.rp_id,
            "credentialId": b64u(&self.credential_id),
            "userHandle": b64u(&req.user_id),
            "userName": req.user_name,
            "displayName": req.display_name,
            "rpName": req.rp_name,
            "key": b64u(&self.pkcs8),
            "alg": ES256,
            "created": created_ms,
        })
    }

    /// What the extension gets back from a registration (public data only).
    pub fn reply(&self, rp_id: &str) -> Value {
        let auth = self.auth_data(rp_id);
        json!({
            "ok": true,
            "credentialId": b64u(&self.credential_id),
            "attestationObject": b64u(&attestation_object_none(&auth)),
            "authenticatorData": b64u(&auth),
            "publicKey": b64u(&spki_p256(&self.public_point)),
            "alg": ES256,
        })
    }
}

/// Signs an assertion: returns `(authenticatorData, DER signature)` over `authData ‖ clientDataHash`.
pub fn sign_assertion(pkcs8: &[u8], rp_id: &str, client_data_hash: &[u8; 32]) -> Result<(Vec<u8>, Vec<u8>), &'static str> {
    let rng = SystemRandom::new();
    let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8, &rng).map_err(|_| "bad_key")?;
    let auth = authenticator_data(rp_id, FLAGS, 0, None);
    let mut msg = auth.clone();
    msg.extend_from_slice(client_data_hash);
    let sig = pair.sign(&rng, &msg).map_err(|_| "failed")?;
    Ok((auth, sig.as_ref().to_vec()))
}

// ─── Stored passkeys (on Login entries) ──────────────────────────────────────

/// A passkey as read back from a Login entry's `passkeys` list.
pub struct StoredPasskey {
    pub credential_id: String,
    pub user_handle: String,
    pub pkcs8: Zeroizing<Vec<u8>>,
}

/// Finds the passkey `credential_id` for `rp_id` in a Login entry's JSON content. The RP ID must match
/// exactly: a passkey is never used for another RP, whatever the entry's website says.
pub fn find_in_login(content: &str, rp_id: &str, credential_id: &str) -> Option<StoredPasskey> {
    let v: Value = serde_json::from_str(content).ok()?;
    let list = v.get("passkeys")?.as_array()?;
    let p = list.iter().find(|p| {
        p.get("rpId").and_then(|x| x.as_str()) == Some(rp_id)
            && p.get("credentialId").and_then(|x| x.as_str()) == Some(credential_id)
    })?;
    if p.get("alg").and_then(|a| a.as_i64()).unwrap_or(ES256) != ES256 {
        return None;
    }
    let key = Zeroizing::new(b64u_decode(p.get("key")?.as_str()?)?);
    let user_handle = p.get("userHandle").and_then(|x| x.as_str()).filter(|h| b64u_decode(h).is_some()).unwrap_or("");
    Some(StoredPasskey { credential_id: credential_id.to_string(), user_handle: user_handle.to_string(), pkcs8: key })
}

/// The assertion reply for the extension (public data and the signature only).
pub fn assertion_reply(stored: &StoredPasskey, rp_id: &str, client_data_hash: &[u8; 32]) -> Result<Value, &'static str> {
    let (auth, sig) = sign_assertion(&stored.pkcs8, rp_id, client_data_hash)?;
    Ok(json!({
        "ok": true,
        "credentialId": stored.credential_id,
        "authenticatorData": b64u(&auth),
        "signature": b64u(&sig),
        "userHandle": stored.user_handle,
    }))
}

/// A credential id as the prompt window returns it (base64url, 1..=1023 bytes).
pub fn valid_credential_id(v: Option<&Value>) -> Option<String> {
    id_field(v, MAX_ID_BYTES).ok().map(|b| b64u(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};

    fn client_json(t: &str, origin: &str) -> Vec<u8> {
        format!(r#"{{"type":"{t}","challenge":"{}","origin":"{origin}","crossOrigin":false}}"#, b64u(&[7u8; 32])).into_bytes()
    }

    #[test]
    fn base64url_is_strict() {
        assert_eq!(b64u(&[0xfb, 0xff]), "-_8");
        assert_eq!(b64u_decode("-_8"), Some(vec![0xfb, 0xff]));
        for bad in ["+/8", "-_8=", "a b", "é"] {
            assert_eq!(b64u_decode(bad), None, "{bad}");
        }
    }

    #[test]
    fn public_suffixes_come_from_the_app_table() {
        assert_eq!(public_suffix("www.bbc.co.uk"), "co.uk");
        assert_eq!(public_suffix("github.com"), "com");
        assert_eq!(public_suffix("me.github.io"), "github.io");
        assert_eq!(public_suffix("foo.bar.ck"), "bar.ck"); // wildcard *.ck
        assert_eq!(public_suffix("www.ck"), "ck"); // exception !www.ck
        assert!(psl().rules.len() > 500, "the table was parsed");
    }

    #[test]
    fn rp_id_rule() {
        let ok = [
            ("github.com", "github.com"),
            ("github.com", "www.github.com"),
            ("example.co.uk", "login.example.co.uk"),
            ("login.example.co.uk", "login.example.co.uk"),
            ("me.github.io", "me.github.io"),
            ("localhost", "localhost"),
        ];
        for (rp, host) in ok {
            assert!(rp_id_valid(rp, host), "{rp} for {host}");
        }
        let bad = [
            ("com", "github.com"),            // a public suffix
            ("co.uk", "example.co.uk"),       // a multi-label public suffix
            ("github.io", "me.github.io"),    // a private-section public suffix
            ("github.io", "github.io"),
            ("evil.com", "github.com"),       // unrelated
            ("hub.com", "github.com"),        // string suffix, not a domain suffix
            ("www.github.com", "github.com"), // a child of the origin
            ("other.github.io", "me.github.io"),
            ("127.0.0.1", "127.0.0.1"),
            ("localhost", "app.localhost"),
            ("GitHub.com", "github.com"),
            ("", "github.com"),
            ("github.com.", "github.com"),
            ("a..com", "a..com"),
        ];
        for (rp, host) in bad {
            assert!(!rp_id_valid(rp, host), "{rp} for {host}");
        }
    }

    #[test]
    fn origins_must_be_secure_domains() {
        assert_eq!(origin_host("https://www.github.com"), Ok("www.github.com".into()));
        assert_eq!(origin_host("https://example.com:8443"), Ok("example.com".into()));
        assert_eq!(origin_host("http://localhost:8000"), Ok("localhost".into()));
        for bad in [
            "http://example.com", "https://example.com/", "https://user@example.com", "https://1.2.3.4", "http://127.0.0.1",
            "https://[::1]", "ftp://example.com", "https://EXAMPLE.com", "https://example.com:", "https://example.com:123456",
            "example.com", "",
        ] {
            assert!(origin_host(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn cbor_encodings() {
        let enc = |v: i64| { let mut o = vec![]; cbor_int(&mut o, v); o };
        assert_eq!(enc(0), [0x00]);
        assert_eq!(enc(23), [0x17]);
        assert_eq!(enc(24), [0x18, 0x18]);
        assert_eq!(enc(1000), [0x19, 0x03, 0xe8]);
        assert_eq!(enc(-1), [0x20]);
        assert_eq!(enc(-7), [0x26]);
        assert_eq!(enc(-1000), [0x39, 0x03, 0xe7]);
        let mut t = vec![];
        cbor_text(&mut t, "fmt");
        assert_eq!(t, [0x63, b'f', b'm', b't']);
        let mut b = vec![];
        cbor_bytes(&mut b, &[0u8; 300]);
        assert_eq!(&b[..3], &[0x59, 0x01, 0x2c]);
    }

    #[test]
    fn cose_key_layout() {
        let k = cose_es256(&[0x11; 32], &[0x22; 32]);
        assert_eq!(k.len(), 77);
        assert_eq!(&k[..10], &[0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
        assert_eq!(&k[10..42], &[0x11; 32]);
        assert_eq!(&k[42..45], &[0x22, 0x58, 0x20]);
        assert_eq!(&k[45..], &[0x22; 32]);
    }

    #[test]
    fn attestation_object_is_canonical_none() {
        let att = attestation_object_none(&[1, 2, 3]);
        let mut want = vec![0xa3, 0x63];
        want.extend_from_slice(b"fmt");
        want.push(0x64);
        want.extend_from_slice(b"none");
        want.push(0x67);
        want.extend_from_slice(b"attStmt");
        want.push(0xa0);
        want.push(0x68);
        want.extend_from_slice(b"authData");
        want.extend_from_slice(&[0x43, 1, 2, 3]);
        assert_eq!(att, want);
    }

    #[test]
    fn registration_auth_data_layout() {
        let c = generate().unwrap();
        let a = c.auth_data("github.com");
        assert_eq!(&a[..32], Sha256::digest(b"github.com").as_slice());
        assert_eq!(a[32], FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS | FLAG_AT);
        assert_eq!(a[32], 0x5d);
        assert_eq!(&a[33..37], &[0, 0, 0, 0], "signCount stays 0");
        assert_eq!(&a[37..53], &AAGUID);
        assert_eq!(&a[53..55], &(CRED_ID_LEN as u16).to_be_bytes());
        assert_eq!(&a[55..55 + CRED_ID_LEN], c.credential_id.as_slice());
        let cose = &a[55 + CRED_ID_LEN..];
        assert_eq!(cose.len(), 77);
        assert_eq!(&cose[10..42], &c.public_point[1..33]);
        assert_eq!(&cose[45..77], &c.public_point[33..65]);
        // The attestation object embeds exactly this authData.
        let att = attestation_object_none(&a);
        assert!(att.ends_with(&a));
        let spki = spki_p256(&c.public_point);
        assert_eq!(spki.len(), 91);
        assert_eq!(spki[0], 0x30);
    }

    #[test]
    fn assertion_flags_have_no_attested_data() {
        let a = authenticator_data("example.com", FLAGS | FLAG_AT, 0, None);
        assert_eq!(a.len(), 37);
        assert_eq!(a[32], 0x1d);
    }

    #[test]
    fn sign_and_verify_round_trip() {
        let c = generate().unwrap();
        let hash: [u8; 32] = Sha256::digest(b"client data").into();
        let (auth, sig) = sign_assertion(&c.pkcs8, "github.com", &hash).unwrap();
        let mut msg = auth.clone();
        msg.extend_from_slice(&hash);
        let pk = UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, c.public_point);
        assert!(pk.verify(&msg, &sig).is_ok());
        // Another RP's authData or another client data hash does not verify.
        let mut other = authenticator_data("evil.com", FLAGS, 0, None);
        other.extend_from_slice(&hash);
        assert!(pk.verify(&other, &sig).is_err());
        let mut tampered = msg.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(pk.verify(&tampered, &sig).is_err());
    }

    #[test]
    fn stored_record_round_trip() {
        let c = generate().unwrap();
        let cd = client_json("webauthn.create", "https://www.github.com");
        let req = validate_create(&json!({
            "origin": "https://www.github.com", "rpId": "github.com", "rpName": "GitHub",
            "user": { "id": b64u(b"user-1"), "name": "octo", "displayName": "Octo Cat" },
            "clientDataJSON": b64u(&cd), "algs": [-8, -7, -257],
        }))
        .unwrap();
        let rec = c.record(&req, 1_700_000_000_000);
        assert_eq!(rec["userHandle"], b64u(b"user-1"));
        let login = json!({ "v": 1, "kind": "login", "title": "GitHub", "passkeys": [rec] }).to_string();
        let id = b64u(&c.credential_id);
        assert!(find_in_login(&login, "evil.com", &id).is_none(), "never for another RP");
        assert!(find_in_login(&login, "github.com", "AAAA").is_none());
        let s = find_in_login(&login, "github.com", &id).unwrap();
        let hash: [u8; 32] = Sha256::digest(b"x").into();
        let r = assertion_reply(&s, "github.com", &hash).unwrap();
        assert_eq!(r["userHandle"], b64u(b"user-1"));
        let mut msg = b64u_decode(r["authenticatorData"].as_str().unwrap()).unwrap();
        msg.extend_from_slice(&hash);
        let sig = b64u_decode(r["signature"].as_str().unwrap()).unwrap();
        assert!(UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, c.public_point).verify(&msg, &sig).is_ok());
        // The extension's reply carries no private key.
        let reply = c.reply("github.com").to_string();
        assert!(!reply.contains(rec["key"].as_str().unwrap()));
    }

    #[test]
    fn create_validation() {
        let cd = client_json("webauthn.create", "https://www.github.com");
        let good = json!({
            "origin": "https://www.github.com", "rpId": "github.com", "rpName": "Git\u{0007}Hub",
            "user": { "id": b64u(b"u"), "name": "octo", "displayName": "" },
            "clientDataJSON": b64u(&cd), "algs": [-7], "exclude": [b64u(b"old")],
        });
        let r = validate_create(&good).unwrap();
        assert_eq!((r.host.as_str(), r.rp_id.as_str(), r.rp_name.as_str()), ("www.github.com", "github.com", "GitHub"));
        assert_eq!(r.exclude, vec![b64u(b"old")]);
        assert_eq!(r.client_data_hash, <[u8; 32]>::from(Sha256::digest(&cd)));

        let with = |k: &str, v: Value| { let mut g = good.clone(); g[k] = v; g };
        assert_eq!(validate_create(&with("rpId", json!("com"))).unwrap_err(), "bad_rp_id");
        assert_eq!(validate_create(&with("rpId", json!("evil.com"))).unwrap_err(), "bad_rp_id");
        assert_eq!(validate_create(&with("origin", json!("http://www.github.com"))).unwrap_err(), "not_https");
        assert_eq!(validate_create(&with("algs", json!([-257]))).unwrap_err(), "unsupported_alg");
        assert!(validate_create(&with("algs", json!([]))).is_ok());
        assert!(validate_create(&with("user", json!({ "id": b64u(&[0u8; 65]), "name": "x" }))).is_err());
        assert!(validate_create(&with("user", json!({ "name": "x" }))).is_err());
        assert!(validate_create(&with("exclude", json!(["not base64!"]))).is_err());
        // Client data for another origin, type or ceremony is refused.
        let other = client_json("webauthn.create", "https://evil.com");
        assert_eq!(validate_create(&with("clientDataJSON", json!(b64u(&other)))).unwrap_err(), "bad_origin");
        let get = client_json("webauthn.get", "https://www.github.com");
        assert_eq!(validate_create(&with("clientDataJSON", json!(b64u(&get)))).unwrap_err(), "bad_origin");
    }

    #[test]
    fn get_validation_and_cross_origin_frames() {
        let good = |cd: &[u8]| json!({ "origin": "https://login.example.co.uk", "rpId": "example.co.uk",
            "clientDataJSON": b64u(cd), "allow": [b64u(b"cred")] });
        let cd = client_json("webauthn.get", "https://login.example.co.uk");
        let r = validate_get(&good(&cd)).unwrap();
        assert_eq!(r.allow, vec![b64u(b"cred")]);
        // A same-site subframe: the RP ID must suit the top page too.
        let framed = |top: &str| format!(
            r#"{{"type":"webauthn.get","challenge":"AAAA","origin":"https://login.example.co.uk","crossOrigin":true,"topOrigin":"{top}"}}"#
        );
        assert!(validate_get(&good(framed("https://www.example.co.uk").as_bytes())).is_ok());
        assert_eq!(validate_get(&good(framed("https://evil.com").as_bytes())).unwrap_err(), "bad_rp_id");
        let no_top = br#"{"type":"webauthn.get","challenge":"AAAA","origin":"https://login.example.co.uk","crossOrigin":true}"#;
        assert_eq!(validate_get(&good(no_top)).unwrap_err(), "bad_origin");
        let no_challenge = br#"{"type":"webauthn.get","origin":"https://login.example.co.uk"}"#;
        assert!(validate_get(&good(no_challenge)).is_err());
        let mut many = good(&cd);
        many["allow"] = json!(vec![b64u(b"c"); MAX_LIST + 1]);
        assert!(validate_get(&many).is_err());
    }
}
