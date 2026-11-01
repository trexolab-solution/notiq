//! Password-reuse / phishing check for the browser extension (ops `reuse_salt` and `reuse_check`).
//!
//! When the user leaves a password field (blur) or submits a form, the extension asks whether the password just
//! typed is the one of a login saved for ANOTHER site ("This is your password for paypal.com. This site is
//! paypa1.com."). The password itself never leaves the extension:
//!
//! * `{op:"reuse_salt"}` → `{ok:true, salt}` (64 hex chars, random per app run) | `{error:"locked"}`.
//! * `{op:"reuse_check", host, salt, tag}` → `{ok:true, site:null}` | `{ok:true, site:"paypal.com"}` |
//!   `{error:"locked"|"stale_salt"|"rate_limited"|"bad_request"|"bad_host"}`. `tag` is
//!   HMAC-SHA256(salt, password) cut to 16 bytes (32 hex chars), computed in the page's content script.
//!
//! The app computes the same tag for every live login of the unlocked vault (passwords of 8+ characters only) and
//! answers with only the matched login's site as a display host (its registrable domain), or `null`. No warning is
//! given when ANY login with that password belongs to the page's site (its main URL or one of its other sites is
//! the page host, or on the same registrable domain per the Public Suffix List; IPs and `localhost` only match
//! themselves). Neither op shows a window, starts the app, or needs an Allow: they reveal only a site name for a
//! password the user has just typed into the page. A locked vault answers `locked`; checks are rate-limited.

use std::collections::{HashSet, VecDeque};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

pub const SALT_LEN: usize = 32;
pub const TAG_LEN: usize = 16;
/// Shorter passwords are never checked (the extension doesn't send them, the app doesn't compare them).
pub const MIN_PASSWORD_CHARS: usize = 8;
/// At most `RATE_MAX` checks per `RATE_WINDOW_MS`.
pub const RATE_WINDOW_MS: u64 = 60_000;
pub const RATE_MAX: usize = 12;

// ─── Crypto helpers ──────────────────────────────────────────────────────────

/// HMAC-SHA256 (RFC 2104).
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let inner = Sha256::new().chain_update(ipad).chain_update(msg).finalize();
    let out = Sha256::new().chain_update(opad).chain_update(inner).finalize();
    k.zeroize();
    ipad.zeroize();
    opad.zeroize();
    out.into()
}

/// The tag the extension sends: HMAC-SHA256(salt, UTF-8 password), first 16 bytes.
pub fn reuse_tag(salt: &[u8], password: &str) -> [u8; TAG_LEN] {
    let mut full = hmac_sha256(salt, password.as_bytes());
    let mut out = [0u8; TAG_LEN];
    out.copy_from_slice(&full[..TAG_LEN]);
    full.zeroize();
    out
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Lower-case hex of exactly `N` bytes.
fn from_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// This app run's salt (random, never stored).
fn session_salt() -> &'static [u8; SALT_LEN] {
    static SALT: OnceLock<[u8; SALT_LEN]> = OnceLock::new();
    SALT.get_or_init(|| {
        use rand::RngCore;
        let mut b = [0u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut b);
        b
    })
}

// ─── Public Suffix List (the table the extension and the app UI use) ─────────

struct Psl {
    rules: HashSet<String>,
    wild: HashSet<String>,
    except: HashSet<String>,
}

/// The quoted strings between `start` and the next `end` in `src`.
fn quoted_in<'a>(src: &'a str, start: &str, end: &str) -> Vec<&'a str> {
    let Some(at) = src.find(start) else { return vec![] };
    let body = &src[at + start.len()..];
    let body = &body[..body.find(end).unwrap_or(body.len())];
    body.split('"').skip(1).step_by(2).collect()
}

/// Parses `src/lib/publicSuffixData.ts` (the single source of the table; see its header comment).
fn parse_psl(src: &str) -> Psl {
    let mut rules: HashSet<String> = HashSet::new();
    if let Some(at) = src.find("SECOND_LEVEL") {
        let body = &src[at..];
        let body = &body[body.find('{').map_or(0, |i| i + 1)..body.find("};").unwrap_or(body.len())];
        for line in body.lines() {
            let Some((key, val)) = line.split_once(':') else { continue };
            let tld = key.trim().trim_matches('"').trim_matches('\'');
            if tld.is_empty() || tld.starts_with("//") {
                continue;
            }
            let list = val.split('"').nth(1).unwrap_or("");
            for l in list.split_whitespace() {
                rules.insert(format!("{l}.{tld}"));
            }
        }
    }
    rules.extend(quoted_in(src, "EXTRA: string[] = [", "];").into_iter().map(String::from));
    let wild = quoted_in(src, "WILDCARD: string[] = [", "];").into_iter().map(String::from).collect();
    let except = quoted_in(src, "EXCEPTION: string[] = [", "];").into_iter().map(String::from).collect();
    Psl { rules, wild, except }
}

fn psl() -> &'static Psl {
    static P: OnceLock<Psl> = OnceLock::new();
    P.get_or_init(|| parse_psl(include_str!("../../src/lib/publicSuffixData.ts")))
}

fn is_ip(h: &str) -> bool {
    h.contains(':') || (!h.is_empty() && h.bytes().all(|b| b.is_ascii_digit() || b == b'.'))
}

fn is_localhost(h: &str) -> bool {
    h == "localhost" || h.ends_with(".localhost")
}

fn is_rule(p: &Psl, name: &str) -> bool {
    if name.is_empty() || p.except.contains(name) {
        return false;
    }
    match name.split_once('.') {
        None => true,
        Some((_, parent)) => p.rules.contains(name) || p.wild.contains(parent),
    }
}

fn public_suffix<'a>(p: &Psl, h: &'a str) -> &'a str {
    let mut rest = h;
    loop {
        if p.except.contains(rest) {
            return rest.split_once('.').map_or(rest, |(_, s)| s);
        }
        if is_rule(p, rest) {
            return rest;
        }
        match rest.split_once('.') {
            Some((_, s)) => rest = s,
            None => return rest,
        }
    }
}

/// `login.bbc.co.uk` → `bbc.co.uk`; `None` for an IP, `localhost`, an empty host or a public suffix itself.
pub fn registrable_domain(host: &str) -> Option<String> {
    let h = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if h.is_empty() || is_ip(&h) || is_localhost(&h) {
        return None;
    }
    let suffix = public_suffix(psl(), &h);
    if suffix == h {
        return None;
    }
    let rest = &h[..h.len() - suffix.len() - 1];
    let label = rest.rsplit('.').next().filter(|l| !l.is_empty())?;
    Some(format!("{label}.{suffix}"))
}

/// Same site: the exact host, or the same registrable domain. IPs, `localhost` and public suffixes only match
/// themselves (so `a.github.io` and `b.github.io` are different sites).
pub fn same_site(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim().to_ascii_lowercase(), b.trim().to_ascii_lowercase());
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if a == b {
        return true;
    }
    matches!((registrable_domain(&a), registrable_domain(&b)), (Some(x), Some(y)) if x == y)
}

// ─── Matching ────────────────────────────────────────────────────────────────

/// One saved login, reduced to what the check needs: its sites and its password's tag.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    /// Every host of the login (`url` first, then `urls`), lower-case, non-empty.
    pub hosts: Vec<String>,
    pub tag: [u8; TAG_LEN],
}

impl Candidate {
    /// The site shown to the user: the main host's registrable domain (else the host itself).
    pub fn display(&self) -> String {
        let h = &self.hosts[0];
        registrable_domain(h).unwrap_or_else(|| h.clone())
    }
}

/// The login JSON (see `src/lib/loginEntry.ts`); only these fields are read.
#[derive(Deserialize, Default)]
struct LoginDoc {
    #[serde(default)]
    url: String,
    #[serde(default)]
    urls: Vec<String>,
    #[serde(default)]
    password: String,
}

impl Drop for LoginDoc {
    fn drop(&mut self) {
        self.password.zeroize();
    }
}

/// The candidate for one login entry's content, or `None` (not JSON, no site, password under 8 characters).
pub fn candidate(content: &str, salt: &[u8]) -> Option<Candidate> {
    let doc: LoginDoc = serde_json::from_str(content).ok()?;
    if doc.password.chars().count() < MIN_PASSWORD_CHARS {
        return None;
    }
    let mut hosts: Vec<String> = Vec::new();
    for u in std::iter::once(&doc.url).chain(doc.urls.iter()) {
        let h = crate::quick_search::host_of(u);
        let h = h.trim_end_matches('.').to_string();
        if !h.is_empty() && !hosts.contains(&h) {
            hosts.push(h);
        }
    }
    if hosts.is_empty() {
        return None;
    }
    Some(Candidate { hosts, tag: reuse_tag(salt, &doc.password) })
}

/// Does `page` belong to one of the login's sites?
pub fn belongs(page: &str, c: &Candidate) -> bool {
    c.hosts.iter().any(|h| same_site(page, h))
}

/// The site to warn about: the first login (in the given order) with this tag, unless any login with this tag
/// belongs to the page's site (then the user is on a site the password is saved for: no warning).
pub fn find_reuse(page: &str, tag: &[u8; TAG_LEN], logins: &[Candidate]) -> Option<String> {
    let hits: Vec<&Candidate> = logins.iter().filter(|c| ct_eq(&c.tag, tag)).collect();
    if hits.is_empty() || hits.iter().any(|c| belongs(page, c)) {
        return None;
    }
    let site = hits[0].display();
    // Never name the page's own site (belt and braces: `belongs` already covers it).
    if same_site(page, &site) {
        return None;
    }
    Some(site)
}

// ─── Rate limit ──────────────────────────────────────────────────────────────

/// Sliding window: records `now` and returns true when fewer than `max` checks happened in the last `window` ms.
/// Times in the future (clock change) are dropped.
pub fn rate_ok(log: &mut VecDeque<u64>, now: u64, window: u64, max: usize) -> bool {
    log.retain(|&t| t <= now && now - t < window);
    if log.len() >= max {
        return false;
    }
    log.push_back(now);
    true
}

fn rate_log() -> &'static Mutex<VecDeque<u64>> {
    static L: OnceLock<Mutex<VecDeque<u64>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

// ─── Requests ────────────────────────────────────────────────────────────────

/// A validated `reuse_check`: `(host, salt, tag)`.
pub fn validate_check(req: &Value) -> Result<(String, [u8; SALT_LEN], [u8; TAG_LEN]), &'static str> {
    let get = |k: &str| req.get(k).and_then(|v| v.as_str());
    let host = get("host").ok_or("bad_request")?;
    if host.is_empty()
        || host.len() > 253
        || !host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return Err("bad_host");
    }
    let salt = get("salt").and_then(from_hex::<SALT_LEN>).ok_or("bad_request")?;
    let tag = get("tag").and_then(from_hex::<TAG_LEN>).ok_or("bad_request")?;
    Ok((host.to_string(), salt, tag))
}

/// `reuse_check` once the request is valid and the vault unlocked: compares and answers.
pub fn check_reply(host: &str, salt_ok: bool, tag: &[u8; TAG_LEN], logins: &[Candidate]) -> Value {
    if !salt_ok {
        return json!({ "error": "stale_salt" });
    }
    json!({ "ok": true, "site": find_reuse(host, tag, logins) })
}

/// Handles `reuse_salt` / `reuse_check`; `None` for every other op.
pub fn handle_op(app: &AppHandle, op: &str, req: &Value) -> Option<Value> {
    if op != "reuse_salt" && op != "reuse_check" {
        return None;
    }
    let vault = app.state::<crate::vault::VaultState>();
    if op == "reuse_salt" {
        return Some(if vault.is_unlocked() {
            json!({ "ok": true, "salt": to_hex(session_salt()) })
        } else {
            json!({ "error": "locked" })
        });
    }
    let (host, salt, tag) = match validate_check(req) {
        Ok(v) => v,
        Err(e) => return Some(json!({ "error": e })),
    };
    if !rate_ok(&mut rate_log().lock().unwrap_or_else(|e| e.into_inner()), crate::vault_db::now_ms(), RATE_WINDOW_MS, RATE_MAX) {
        return Some(json!({ "error": "rate_limited" }));
    }
    if !vault.is_unlocked() {
        return Some(json!({ "error": "locked" }));
    }
    let ours = session_salt();
    let salt_ok = ct_eq(&salt, ours);
    let logins = if salt_ok {
        let got = vault.with_db_quiet(|db, _, _, _| {
            let list: Vec<Candidate> = db
                .entries
                .values()
                .filter(|e| e.is_live() && !e.dir && e.ext == "login")
                .filter_map(|e| candidate(&e.content, ours))
                .collect();
            Ok((list, false))
        });
        match got {
            Ok(l) => l,
            Err(_) => return Some(json!({ "error": "locked" })),
        }
    } else {
        vec![]
    };
    Some(check_reply(&host, salt_ok, &tag, &logins))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SALT: [u8; SALT_LEN] = [7u8; SALT_LEN];

    fn login(url: &str, urls: &[&str], password: &str) -> String {
        json!({ "v": 1, "kind": "login", "title": "T", "url": url, "urls": urls, "username": "me", "password": password })
            .to_string()
    }
    fn cand(url: &str, urls: &[&str], password: &str) -> Candidate {
        candidate(&login(url, urls, password), &SALT).expect("candidate")
    }
    fn tag(pw: &str) -> [u8; TAG_LEN] {
        reuse_tag(&SALT, pw)
    }

    #[test]
    fn hmac_matches_rfc4231() {
        // RFC 4231 test case 2.
        let mac = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        assert_eq!(to_hex(&mac), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
        // Test case 6: a key longer than the block size is hashed first.
        let key = [0xaau8; 131];
        let mac = hmac_sha256(&key, b"Test Using Larger Than Block-Size Key - Hash Key First");
        assert_eq!(to_hex(&mac), "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
    }

    #[test]
    fn tag_is_truncated_salted_hmac() {
        let t = reuse_tag(&SALT, "correct horse");
        assert_eq!(t.len(), TAG_LEN);
        assert_eq!(&t[..], &hmac_sha256(&SALT, b"correct horse")[..TAG_LEN]);
        assert_ne!(t, reuse_tag(&[8u8; SALT_LEN], "correct horse"), "another salt, another tag");
        // The same value the extension computes with WebCrypto (browser-extension/test/reuse.test.mjs).
        assert_eq!(to_hex(&reuse_tag(&[0u8; SALT_LEN], "Pa55word!")), to_hex(&hmac_sha256(&[0u8; 32], b"Pa55word!")[..16]));
    }

    #[test]
    fn hex_parsing_is_strict() {
        assert_eq!(from_hex::<2>("0aff"), Some([0x0a, 0xff]));
        assert_eq!(from_hex::<2>("0AFF"), None);
        assert_eq!(from_hex::<2>("0af"), None);
        assert_eq!(from_hex::<2>("0afg"), None);
        assert_eq!(from_hex::<2>("+1ff"), None);
    }

    #[test]
    fn psl_table_is_parsed() {
        let p = psl();
        assert!(p.rules.contains("co.uk") && p.rules.contains("github.io") && p.rules.contains("com.br"));
        assert!(p.wild.contains("compute.amazonaws.com") && p.except.contains("www.ck"));
        assert_eq!(registrable_domain("login.bbc.co.uk").as_deref(), Some("bbc.co.uk"));
        assert_eq!(registrable_domain("www.paypal.com").as_deref(), Some("paypal.com"));
        assert_eq!(registrable_domain("me.github.io").as_deref(), Some("me.github.io"));
        assert_eq!(registrable_domain("co.uk"), None);
        assert_eq!(registrable_domain("127.0.0.1"), None);
        assert_eq!(registrable_domain("localhost"), None);
        assert_eq!(registrable_domain("www.ck").as_deref(), Some("www.ck"));
        assert_eq!(registrable_domain("a.b.foo.ck").as_deref(), Some("b.foo.ck"));
    }

    #[test]
    fn same_site_rule() {
        assert!(same_site("accounts.google.com", "mail.google.com"));
        assert!(same_site("paypal.com", "www.paypal.com"));
        assert!(same_site("login.example.co.uk", "www.example.co.uk"));
        assert!(!same_site("paypa1.com", "paypal.com"));
        assert!(!same_site("example.com.evil.io", "example.com"));
        assert!(!same_site("evil.github.io", "me.github.io"));
        assert!(!same_site("a.co.uk", "b.co.uk"));
        assert!(same_site("localhost", "localhost") && !same_site("app.localhost", "localhost"));
        assert!(!same_site("127.0.0.1", "127.0.0.2"));
        assert!(!same_site("", ""));
    }

    #[test]
    fn candidates_need_a_site_and_eight_characters() {
        let c = cand("https://www.PayPal.com/signin", &["paypal.me", " ", "https://www.paypal.com/x"], "hunter2hunter2");
        assert_eq!(c.hosts, vec!["www.paypal.com", "paypal.me"]);
        assert_eq!(c.display(), "paypal.com");
        assert_eq!(c.tag, tag("hunter2hunter2"));
        assert!(candidate(&login("https://a.com", &[], "short7!"), &SALT).is_none(), "7 characters");
        assert!(candidate(&login("https://a.com", &[], "ééééééé"), &SALT).is_none(), "characters, not bytes");
        assert!(candidate(&login("https://a.com", &[], "éééééééé"), &SALT).is_some());
        assert!(candidate(&login("", &[], "long-enough-pw"), &SALT).is_none(), "no site to name");
        assert!(candidate(&login("", &["b.org"], "long-enough-pw"), &SALT).is_some_and(|c| c.display() == "b.org"));
        assert!(candidate("not json", &SALT).is_none());
        assert!(candidate("{}", &SALT).is_none());
        // An IP / localhost login is shown as its host.
        assert_eq!(cand("http://127.0.0.1:8000/login", &[], "long-enough-pw").display(), "127.0.0.1");
    }

    #[test]
    fn warns_only_for_another_site() {
        let logins = vec![
            cand("https://www.paypal.com", &[], "PayPal-Secret-1"),
            cand("https://accounts.google.com", &["https://youtube.com"], "Google-Secret-1"),
            cand("https://bank.example.co.uk", &[], "Bank-Secret-1"),
        ];
        // Phishing look-alike: the PayPal password typed on paypa1.com.
        assert_eq!(find_reuse("paypa1.com", &tag("PayPal-Secret-1"), &logins).as_deref(), Some("paypal.com"));
        assert_eq!(find_reuse("www.paypal.com.evil.io", &tag("PayPal-Secret-1"), &logins).as_deref(), Some("paypal.com"));
        // Its own site, a subdomain, the bare domain: no warning.
        for page in ["www.paypal.com", "paypal.com", "checkout.paypal.com"] {
            assert_eq!(find_reuse(page, &tag("PayPal-Secret-1"), &logins), None, "{page}");
        }
        // "Other sites" of the login and their same-site hosts: no warning.
        for page in ["youtube.com", "m.youtube.com", "mail.google.com"] {
            assert_eq!(find_reuse(page, &tag("Google-Secret-1"), &logins), None, "{page}");
        }
        // Public-suffix aware: another .co.uk site is another site.
        assert_eq!(find_reuse("www.example.co.uk", &tag("Bank-Secret-1"), &logins), None);
        assert_eq!(find_reuse("other.co.uk", &tag("Bank-Secret-1"), &logins).as_deref(), Some("example.co.uk"));
        // A password no login has: nothing.
        assert_eq!(find_reuse("paypa1.com", &tag("Unknown-Secret-1"), &logins), None);
    }

    #[test]
    fn a_password_saved_for_this_site_too_is_no_warning() {
        let logins = vec![cand("https://a.com", &[], "Shared-Pass-1"), cand("https://b.com", &[], "Shared-Pass-1")];
        assert_eq!(find_reuse("b.com", &tag("Shared-Pass-1"), &logins), None);
        assert_eq!(find_reuse("a.com", &tag("Shared-Pass-1"), &logins), None);
        assert_eq!(find_reuse("c.com", &tag("Shared-Pass-1"), &logins).as_deref(), Some("a.com"), "the first login is named");
    }

    #[test]
    fn github_io_tenants_are_different_sites() {
        let logins = vec![cand("https://me.github.io", &[], "Pages-Secret-1")];
        assert_eq!(find_reuse("me.github.io", &tag("Pages-Secret-1"), &logins), None);
        assert_eq!(find_reuse("evil.github.io", &tag("Pages-Secret-1"), &logins).as_deref(), Some("me.github.io"));
    }

    #[test]
    fn check_validation() {
        let ok = json!({ "op": "reuse_check", "host": "paypa1.com", "salt": "07".repeat(32), "tag": "ab".repeat(16) });
        let (host, salt, t) = validate_check(&ok).unwrap();
        assert_eq!((host.as_str(), salt, t), ("paypa1.com", SALT, [0xab; 16]));
        let with = |k: &str, v: Value| {
            let mut r = ok.clone();
            r[k] = v;
            validate_check(&r).err()
        };
        assert_eq!(with("host", json!("PayPal.com")), Some("bad_host"));
        assert_eq!(with("host", json!("a.com/x")), Some("bad_host"));
        assert_eq!(with("host", json!("")), Some("bad_host"));
        assert_eq!(with("host", json!(1)), Some("bad_request"));
        assert_eq!(with("salt", json!("07")), Some("bad_request"));
        assert_eq!(with("tag", json!("ab".repeat(32))), Some("bad_request"), "a full-length hash is refused");
        assert_eq!(with("tag", json!("AB".repeat(16))), Some("bad_request"));
        assert_eq!(with("tag", Value::Null), Some("bad_request"));
    }

    #[test]
    fn replies_carry_only_a_site() {
        let logins = vec![cand("https://www.paypal.com/login", &[], "PayPal-Secret-1")];
        assert_eq!(check_reply("paypa1.com", true, &tag("PayPal-Secret-1"), &logins), json!({ "ok": true, "site": "paypal.com" }));
        assert_eq!(check_reply("paypa1.com", true, &tag("nope-nope-nope"), &logins), json!({ "ok": true, "site": null }));
        assert_eq!(check_reply("paypa1.com", false, &tag("PayPal-Secret-1"), &logins), json!({ "error": "stale_salt" }));
        let r = check_reply("paypa1.com", true, &tag("PayPal-Secret-1"), &logins).to_string();
        assert!(!r.contains("PayPal-Secret-1") && !r.contains("www.paypal.com/login"));
    }

    #[test]
    fn rate_limit_window() {
        let mut log = VecDeque::new();
        for i in 0..RATE_MAX as u64 {
            assert!(rate_ok(&mut log, 1_000 + i, RATE_WINDOW_MS, RATE_MAX));
        }
        assert!(!rate_ok(&mut log, 2_000, RATE_WINDOW_MS, RATE_MAX), "the 13th check in a minute");
        assert!(!rate_ok(&mut log, 1_000 + RATE_WINDOW_MS - 1, RATE_WINDOW_MS, RATE_MAX));
        // Refused checks don't count; once the first one ages out, one more is allowed.
        assert!(rate_ok(&mut log, 1_000 + RATE_WINDOW_MS, RATE_WINDOW_MS, RATE_MAX));
        assert!(!rate_ok(&mut log, 1_000 + RATE_WINDOW_MS, RATE_WINDOW_MS, RATE_MAX));
        // A clock that jumped back drops the "future" entries instead of locking the check out.
        assert!(rate_ok(&mut log, 10, RATE_WINDOW_MS, RATE_MAX));
        assert_eq!(log.len(), 1);
    }
}
