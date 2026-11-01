//! Browser autofill bridge.
//!
//! ```text
//! browser extension ⇄ (native messaging, stdio) ⇄ `notiq --native-host`
//!                                                   ⇄ (127.0.0.1 TCP + token) ⇄ running Notiq app
//! ```
//!
//! The app never hands out a secret on its own: every request is forwarded to
//! the UI, which needs the vault to be unlocked and the user to press Allow
//! (or a short, per-site trust window the user opted into in that dialog).
//!
//! Protocol (extension → host → app, one JSON object per message):
//! * `{op:"ping"}` → `{ok:true, appVersion, locked, protocol, minProtocol}` (never starts the app). `locked` is the
//!   vault's lock state; the extension drops any held multi-step password when it is `true`.
//! * `{op:"theme"}` → `{ok:true, theme:{id,mode,bg,...}|null}` from `autofill-theme.json` (never starts the app, no token)
//! * `{op:"launch"}` → `{ok:true}` once the app answers (starts it if needed) or `{error:"app_not_running"}`
//! * `{op:"fill", host, account?}` → `{ok:true, username, password, title, code?}` | `{choose:[{account,title,username}]}`
//!   | `{error}`. `account` is a vault entry's relative path from an earlier `choose`.
//!   Since 0.9.0 the reply may also carry `fields:[{name,value,secret}]`, that login's custom fields, which the
//!   extension fills by name (secret ones only on the login's own site); older extensions ignore it.
//!   With `intent:"code"` (a separate 2FA page) only logins with a TOTP secret count and the reply is
//!   `{ok:true, username, title, code}` (never the password) or `{error:"no_code"}`.
//! * `{op:"save", host, url, username, password, title}` → `{ok:true, status}` | `{error}`
//! * `{op:"fill_card", host, origin}` → `{ok:true, title, name, number, exp_month, exp_year, csc}` | `{error}`.
//!   Always asks the user (no trust window) and is never handled by the main-window fallback.
//! * `{op:"fill_identity", host, origin, account?}` → `{ok:true, title, name, email, phone, address1, address2, city,
//!   state, postal, country}` | `{error}`. Same origin rule and routing as `fill_card`; the user always picks the
//!   identity (`account`, from `identities`, only pre-selects it).
//! * `{op:"identities"}` → `{ok:true, identities:[{account, title}]}` (file names of Identity entries only, at most
//!   20) | `{error:"locked"}`. Answered by the app itself without any window, only while the vault is unlocked;
//!   never starts the app. Used for the browser's right-click menu.
//! * Toolbar popup (0.9.0; older apps answer `{error:"unknown_op"}`). None of these starts the app or uses the
//!   main-window fallback; see "Popup ops" below for the gating:
//!   * `{op:"list", host}` → `{ok:true, accounts:[{account,title,username,totp}]}` | `{error}`: titles and usernames
//!     of the logins that match `host` only (never a secret), only while the vault is unlocked, no prompt.
//!   * `{op:"copy", host, account, what:"username"|"password"|"code"}` → `{ok:true, copied, clearAfter}` | `{error}`:
//!     the APP copies the value (kept out of clipboard history, cleared after the user's setting); the value never
//!     reaches the extension. Password / code: approved like a fill (prompt, or the site's trust window).
//!   * `{op:"open", host, account}` → `{ok:true}`: brings Notiq forward and opens that entry.
//! * Password-reuse warning: `{op:"reuse_salt"}` → `{ok:true, salt}` and `{op:"reuse_check", host, salt, tag}` →
//!   `{ok:true, site:null|"paypal.com"}` | `{error}` (no window, never starts the app, rate-limited; the password
//!   never leaves the extension, only a salted truncated HMAC of it). See `autofill_reuse.rs`.
//!
//! Every request from protocol-2 extensions also carries `ext` (the extension's version) and `protocol`
//! (its [`PROTOCOL`] number; missing = 1). Compatibility: the app serves extensions with
//! `protocol >= MIN_EXTENSION_PROTOCOL` (others get `{error:"extension_outdated", appVersion, minProtocol}`), and
//! the extension needs `app protocol >= its MIN_APP_PROTOCOL` (`browser-extension/shared.js`), read from `ping`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::native_host_reg::LastRequest;
use crate::vault::atomic_write;

pub const HOST_NAME: &str = crate::profile::PROD_IDENTIFIER;
/// Version of the extension ⇄ app message protocol. Keep equal to `PROTOCOL` in `browser-extension/shared.js`
/// (a test checks it). 1: the original messages. 2: `ping` reports `appVersion`/`locked`/`protocol`/`minProtocol`,
/// requests carry `ext`/`protocol`, and an outdated extension is told so.
pub const PROTOCOL: u64 = 2;
/// Oldest extension protocol this app still serves (an extension that sends no `protocol` is protocol 1).
/// Raise it only when a change would make older extensions misbehave; they are then asked to update.
pub const MIN_EXTENSION_PROTOCOL: u64 = 1;
/// Chromium extension IDs allowed to talk to the native host (the manifest's `allowed_origins` and the host's own
/// origin check). Empty slots are skipped; fill them in once the store listings exist.
pub const EXTENSION_IDS: &[&str] = &[
    // Developer-mode (unpacked) build: fixed by the `key` in `browser-extension/manifest.json`.
    "cfddmbiaaboejbhnijkjodcganjdbcel",
    // Chrome Web Store listing ID (not published yet).
    "",
    // Microsoft Edge Add-ons listing ID (not published yet).
    "",
];
/// Firefox add-on (gecko) IDs for the manifest's `allowed_extensions`. A placeholder until a Firefox build of the
/// extension exists; it must equal `browser_specific_settings.gecko.id` in that build's manifest.
pub const FIREFOX_EXTENSION_IDS: &[&str] = &["autofill@notiq.app"];
/// Optional `<app-data>/autofill_extensions.json`: a JSON array of extra Chromium extension IDs (e.g. a store ID),
/// so one can be added without rebuilding. Entries that are not `^[a-p]{32}$` are ignored.
const EXTRA_IDS_FILE: &str = "autofill_extensions.json";
const IPC_FILE: &str = "autofill_ipc.json";
/// Written by a native host that is starting the app, so concurrent requests don't start it twice.
const LAUNCH_LOCK: &str = "autofill_launch.lock";
/// No second launch is attempted within this window.
const LAUNCH_BACKOFF_MS: u64 = 15_000;
/// How long a native host waits for a just-launched app.
const LAUNCH_WAIT: Duration = Duration::from_secs(12);
const MAX_MSG: usize = 1024 * 1024;
/// How long the user has to answer the prompt.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(90);

type Pending = Mutex<HashMap<String, Sender<Value>>>;
fn pending() -> &'static Pending {
    static P: OnceLock<Pending> = OnceLock::new();
    P.get_or_init(Default::default)
}

fn random_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Same folder Tauri uses for `app_data_dir()`, resolvable without a running app
/// (the native host is a bare process).
pub(crate) fn data_dir_plain() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join(crate::profile::identifier()))
}

// ─── Allowed extensions ──────────────────────────────────────────────────────

/// A Chromium extension ID: 32 letters `a`..=`p`.
pub fn valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// Built-in IDs plus the valid, de-duplicated IDs from an `autofill_extensions.json` document.
pub fn merge_extension_ids(extra_json: Option<&str>) -> Vec<String> {
    let mut out: Vec<String> = EXTENSION_IDS.iter().filter(|s| valid_extension_id(s)).map(|s| s.to_string()).collect();
    let extra = extra_json
        .and_then(|raw| serde_json::from_str::<Vec<Value>>(raw).ok())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
        .filter(|s| valid_extension_id(s))
        .take(32);
    for id in extra {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// Every Chromium extension ID the native host currently accepts.
pub fn known_extension_ids() -> Vec<String> {
    let raw = data_dir_plain().and_then(|d| std::fs::read_to_string(d.join(EXTRA_IDS_FILE)).ok());
    merge_extension_ids(raw.as_deref())
}

/// Was the host started by an allowed extension? Chromium passes `chrome-extension://<id>/`; Firefox passes the
/// manifest path and then the add-on ID.
pub fn origin_allowed(args: &[String], chromium_ids: &[String]) -> bool {
    args.iter().any(|a| {
        chromium_ids.iter().any(|id| *a == format!("chrome-extension://{id}/")) || FIREFOX_EXTENSION_IDS.contains(&a.as_str())
    })
}

// ─── Bridge health (shown in Settings; never holds secrets) ──────────────────

static IPC_PORT: AtomicU32 = AtomicU32::new(0);
static EXTENSION_LAST_SEEN: AtomicU64 = AtomicU64::new(0);
/// Set once the UI listens for `autofill:request` (see `autofill_ui_ready`).
static UI_READY: AtomicBool = AtomicBool::new(false);

fn last_req_slot() -> &'static Mutex<Option<LastRequest>> {
    static L: OnceLock<Mutex<Option<LastRequest>>> = OnceLock::new();
    L.get_or_init(Default::default)
}

fn touch_extension() {
    EXTENSION_LAST_SEEN.store(now_ms(), Ordering::Relaxed);
}

pub(crate) fn extension_last_seen_ms() -> Option<u64> {
    Some(EXTENSION_LAST_SEEN.load(Ordering::Relaxed)).filter(|&t| t > 0)
}

pub(crate) fn last_request() -> Option<LastRequest> {
    last_req_slot().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The listener is up and the published `{port, token}` file still names it.
pub(crate) fn ipc_ok() -> bool {
    let port = IPC_PORT.load(Ordering::Relaxed);
    port != 0
        && data_dir_plain()
            .and_then(|d| std::fs::read_to_string(d.join(IPC_FILE)).ok())
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|v| v.get("port").and_then(|p| p.as_u64()))
            == Some(port as u64)
}

/// A short, secret-free label for what a reply did (`ok`, `saved`, `choose`, `denied`, `locked`, …).
pub fn outcome_of(reply: &Value) -> String {
    let word = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect::<String>();
    if let Some(e) = reply.get("error").and_then(|e| e.as_str()) {
        return word(e);
    }
    if reply.get("choose").is_some() {
        return "choose".into();
    }
    match reply.get("status").and_then(|s| s.as_str()) {
        Some(s) => word(s),
        None => "ok".into(),
    }
}

fn record_request(host: &str, reply: &Value) {
    let rec = LastRequest { at_ms: now_ms(), host: clean(host), outcome: outcome_of(reply) };
    *last_req_slot().lock().unwrap_or_else(|e| e.into_inner()) = Some(rec);
}

// ─── App side ────────────────────────────────────────────────────────────────

/// Starts the local listener and publishes `{port, token}` for the native host.
pub fn start(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else { return };
    let Ok(port) = listener.local_addr().map(|a| a.port()) else { return };
    let token = random_token();
    let doc = json!({ "port": port, "token": token }).to_string();
    if atomic_write(&dir.join(IPC_FILE), doc.as_bytes()).is_err() {
        return;
    }
    IPC_PORT.store(port as u32, Ordering::Relaxed);
    // Release builds (re)register the native host. A dev build must not point the browsers at the debug exe (that
    // would break autofill for the installed app); it only registers when the user presses Repair in Settings.
    std::thread::spawn(crate::native_host_reg::register_at_startup);

    let app = app.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || serve(app, conn, &token));
        }
    });
}

fn serve(app: AppHandle, conn: TcpStream, token: &str) {
    let _ = conn.set_nodelay(true);
    let Ok(mut out) = conn.try_clone() else { return };
    let mut rd = BufReader::new(conn.take(MAX_MSG as u64 * 64));
    let mut line = String::new();

    // First line must carry the token.
    if rd.read_line(&mut line).is_err() {
        return;
    }
    let ok = serde_json::from_str::<Value>(line.trim())
        .ok()
        .and_then(|v| v.get("token").and_then(|t| t.as_str()).map(|t| ct_eq(t, token)))
        .unwrap_or(false);
    if !ok {
        return;
    }

    loop {
        line.clear();
        match rd.read_line(&mut line) {
            Ok(0) | Err(_) => return,
            Ok(n) if n > MAX_MSG => return,
            Ok(_) => {}
        }
        let Ok(req) = serde_json::from_str::<Value>(line.trim()) else { return };
        let reply = handle(&app, req);
        if writeln!(out, "{reply}").is_err() {
            return;
        }
    }
}

fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A validated "save this login" request from the browser.
#[derive(Debug, PartialEq)]
pub struct SaveReq {
    pub host: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub title: String,
}

fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

/// Strict validation of an untrusted `save` message. Never logs the password.
pub fn validate_save(req: &Value) -> Result<SaveReq, &'static str> {
    let get = |k: &str| req.get(k).and_then(|v| v.as_str());
    let host = get("host").ok_or("bad_request")?;
    if host.is_empty()
        || host.len() > 253
        || !host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
    {
        return Err("bad_request");
    }
    let url = get("url").ok_or("bad_request")?;
    let url_ok = url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1");
    if url.len() > 2048 || !url_ok || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("bad_request");
    }
    let username = clean(get("username").unwrap_or(""));
    let password = get("password").ok_or("bad_request")?;
    if username.chars().count() > 256 || password.is_empty() || password.len() > 1024 {
        return Err("bad_request");
    }
    let title = clean(get("title").unwrap_or("")).trim().to_string();
    if title.chars().count() > 80 {
        return Err("bad_request");
    }
    Ok(SaveReq {
        host: host.to_string(),
        url: url.to_string(),
        username,
        password: password.to_string(),
        title,
    })
}

/// Validates the optional `account` of a `fill` request: a vault entry's relative path.
/// Missing / `null` / `""` → no account; otherwise ≤ 512 chars, no control chars, not absolute, no `..`.
pub fn validate_account(v: Option<&Value>) -> Result<Option<String>, &'static str> {
    let s = match v {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(s)) => s,
        Some(_) => return Err("bad_request"),
    };
    if s.is_empty() {
        return Ok(None);
    }
    let bad = s.chars().count() > 512
        || s.chars().any(|c| c.is_control())
        || s.starts_with('/')
        || s.starts_with('\\')
        || s.contains(':')
        || s.contains("..");
    if bad {
        return Err("bad_request");
    }
    Ok(Some(s.clone()))
}

/// Validates the optional `intent` of a `fill` request. Missing / `null` → a normal fill;
/// `"code"` → only the TOTP code of the matching login; anything else is refused.
pub fn validate_intent(v: Option<&Value>) -> Result<Option<&'static str>, &'static str> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s == "code" => Ok(Some("code")),
        Some(_) => Err("bad_request"),
    }
}

/// A page host as the extension sends it: lower-case letters, digits, dots and dashes, 1..=253 chars.
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

/// Strict validation of an untrusted `fill_card` message; returns the page host.
/// `origin` must be that host's own `https://` origin (optionally with a port); plain `http://` is accepted only
/// for `localhost` / `127.0.0.1`, so a card is never sent to an insecure page.
pub fn validate_fill_card(req: &Value) -> Result<String, &'static str> {
    let get = |k: &str| req.get(k).and_then(|v| v.as_str());
    let host = get("host").ok_or("bad_request")?;
    if !valid_host(host) {
        return Err("bad_host");
    }
    let origin = get("origin").ok_or("bad_request")?;
    if origin.len() > 300 {
        return Err("bad_request");
    }
    let local = host == "localhost" || host == "127.0.0.1";
    let rest = origin
        .strip_prefix("https://")
        .or_else(|| if local { origin.strip_prefix("http://") } else { None })
        .ok_or("not_https")?;
    let port_ok = |p: &str| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit());
    let ok = match rest.strip_prefix(host) {
        Some("") => true,
        Some(p) => p.strip_prefix(':').is_some_and(port_ok),
        None => false,
    };
    if !ok {
        return Err("bad_request");
    }
    Ok(host.to_string())
}

// ─── Identities (browser right-click menu + in-page identity icon) ────────────

/// Strict validation of an untrusted `fill_identity` message: the `fill_card` origin rule plus an optional
/// `account` (an identity's vault path from an earlier `identities` reply). Returns `(host, account)`.
pub fn validate_fill_identity(req: &Value) -> Result<(String, Option<String>), &'static str> {
    let host = validate_fill_card(req)?;
    let account = validate_account(req.get("account"))?;
    Ok((host, account))
}

/// Most identities listed for the right-click menu.
pub const MAX_IDENTITIES: usize = 20;
const IDENTITY_EXT: &str = "identity";

/// `identities` reply from the vault listing: live Identity entries only, titled by their file name (control
/// characters dropped, at most 60 characters), sorted by title, at most [`MAX_IDENTITIES`]. No field values.
pub fn identities_reply(items: &[crate::vault_db::ListItem]) -> Value {
    let mut out: Vec<(String, String)> = items
        .iter()
        .filter(|i| !i.dir && i.ext == IDENTITY_EXT && i.trashed_at.is_none())
        .filter_map(|i| {
            let rel = i.rel.replace('\\', "/");
            let lower = rel.to_ascii_lowercase();
            let stem = rel.get(..rel.len().checked_sub(4)?).filter(|_| lower.ends_with(".nqv"))?;
            let name = stem.rsplit('/').next().unwrap_or(stem);
            let title: String = name.chars().filter(|c| !c.is_control()).take(60).collect::<String>().trim().to_string();
            if title.is_empty() || validate_account(Some(&json!(rel))).ok().flatten().is_none() {
                return None;
            }
            Some((title, rel))
        })
        .collect();
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()).then_with(|| a.1.cmp(&b.1)));
    out.truncate(MAX_IDENTITIES);
    let list: Vec<Value> = out.into_iter().map(|(title, account)| json!({ "account": account, "title": title })).collect();
    json!({ "ok": true, "identities": list })
}

/// The protocol a request speaks: its `protocol` field, or 1 when it has none (extensions before protocol 2).
/// Anything but a positive integer is a bad request.
pub fn request_protocol(req: &Value) -> Result<u64, &'static str> {
    match req.get("protocol") {
        None | Some(Value::Null) => Ok(1),
        Some(v) => v.as_u64().filter(|&p| p > 0).ok_or("bad_request"),
    }
}

/// Is an extension speaking `protocol` served by this app?
pub fn extension_supported(protocol: u64) -> bool {
    protocol >= MIN_EXTENSION_PROTOCOL
}

/// `ping` answer: always sent (even to an outdated extension), so the extension can tell the user what to update.
pub fn ping_reply(app_version: &str, locked: bool) -> Value {
    json!({
        "ok": true,
        "appVersion": app_version,
        "locked": locked,
        "protocol": PROTOCOL,
        "minProtocol": MIN_EXTENSION_PROTOCOL,
    })
}

/// The protocol gate for every op except `ping` / `hello`: `None` = go on, `Some(reply)` = answer with this.
pub fn protocol_gate(req: &Value, app_version: &str) -> Option<Value> {
    match request_protocol(req) {
        Err(e) => Some(json!({ "error": e })),
        Ok(p) if !extension_supported(p) => Some(json!({
            "error": "extension_outdated",
            "appVersion": app_version,
            "minProtocol": MIN_EXTENSION_PROTOCOL,
        })),
        Ok(_) => None,
    }
}

/// Forwards a request to the UI and waits for its answer.
fn handle(app: &AppHandle, req: Value) -> Value {
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let app_version = app.package_info().version.to_string();
    if op != "ping" && op != "hello" {
        if let Some(reply) = protocol_gate(&req, &app_version) {
            return reply;
        }
    }
    if let Some(reply) = handle_popup(app, op, &req) {
        return reply;
    }
    // Password-reuse warning (`reuse_salt`, `reuse_check`): no window, never starts the app (see autofill_reuse.rs).
    if let Some(reply) = crate::autofill_reuse::handle_op(app, op, &req) {
        touch_extension();
        return reply;
    }
    // Card and identity requests are only ever answered by the prompt window (see `await_ui`).
    let fallback = op != "fill_card" && op != "fill_identity";
    let (event, payload, host) = match op {
        "ping" => {
            touch_extension();
            let locked = !app.state::<crate::vault::VaultState>().is_unlocked();
            return ping_reply(&app_version, locked);
        }
        // Liveness check used by the native host itself (not counted as the extension being seen).
        "hello" => return json!({ "ok": true }),
        "fill" => {
            touch_extension();
            let host = req.get("host").and_then(|v| v.as_str()).unwrap_or("");
            if host.is_empty() || host.len() > 253 {
                return json!({ "error": "bad_host" });
            }
            let mut payload = json!({ "host": host });
            match validate_account(req.get("account")) {
                Ok(Some(a)) => payload["account"] = json!(a),
                Ok(None) => {}
                Err(e) => return json!({ "error": e }),
            }
            match validate_intent(req.get("intent")) {
                Ok(Some(i)) => payload["intent"] = json!(i),
                Ok(None) => {}
                Err(e) => return json!({ "error": e }),
            }
            ("autofill:request", payload, host.to_string())
        }
        "save" => {
            touch_extension();
            match validate_save(&req) {
                Ok(s) => (
                    "autofill:save",
                    json!({ "host": s.host, "url": s.url, "username": s.username, "password": s.password, "title": s.title }),
                    s.host.clone(),
                ),
                Err(e) => return json!({ "error": e }),
            }
        }
        "fill_card" => {
            touch_extension();
            match validate_fill_card(&req) {
                Ok(host) => ("autofill:card", json!({ "host": host }), host),
                Err(e) => return json!({ "error": e }),
            }
        }
        "fill_identity" => {
            touch_extension();
            match validate_fill_identity(&req) {
                Ok((host, account)) => {
                    let mut payload = json!({ "host": host });
                    if let Some(a) = account {
                        payload["account"] = json!(a);
                    }
                    ("autofill:identity", payload, host)
                }
                Err(e) => return json!({ "error": e }),
            }
        }
        // Titles for the right-click menu: no window, nothing while locked.
        "identities" => {
            touch_extension();
            let vault = app.state::<crate::vault::VaultState>();
            if !vault.is_unlocked() {
                return json!({ "error": "locked" });
            }
            return match vault.with_db_quiet(|db, _, _, _| Ok((db.list(), false))) {
                Ok(items) => identities_reply(&items),
                Err(_) => json!({ "error": "locked" }),
            };
        }
        _ => return json!({ "error": "unknown_op" }),
    };
    let reply = await_ui(app, event, payload, fallback);
    record_request(&host, &reply);
    reply
}

// ─── Popup ops (0.9.0): list / copy / open ────────────────────────────────────
//
// Gating (see also browser-extension/README.md):
// * `list` needs an unlocked vault and shows no prompt. It is safe without an Allow because only the extension's
//   own popup sends it (the background never forwards it for a page), the host is the active tab's top host
//   (taken from the tab URL by the background, never from the page), and the reply holds only the titles and
//   usernames of the logins that match that host, exactly what the account chooser already hands out. Logins for
//   other sites never leave the app, and a locked vault answers `locked` without listing anything.
// * `copy` of a password or 2FA code is approved exactly like a fill (the prompt, which may ask to unlock, or the
//   site's 5-minute trust window). Copying the username (already shown in the list) needs an unlocked vault but
//   no Allow. The prompt window copies the value itself; the reply is reduced here to `{ok, copied, clearAfter}`.
// * `open` only shows Notiq and opens the entry there (nothing is returned); a locked vault asks to unlock first.

/// Emitted to the prompt window: `{id, host}` → reply `{ok, accounts}`.
const LIST_EVENT: &str = "autofill:list";
/// Emitted to the prompt window: `{id, host, account, what}` → reply `{ok, copied, clearAfter}`.
const COPY_EVENT: &str = "autofill:copy";
/// The main window's existing "open this entry" listener (`src/quick/quickSearch.ts`), payload `{rel}`.
const OPEN_ENTRY_EVENT: &str = "quick-search:open";
/// Most logins one `list` reply may carry (a site with more is unusual; the popup filters them).
pub const MAX_LIST: usize = 50;

/// What a `copy` may copy.
pub fn validate_copy_what(v: Option<&Value>) -> Result<&'static str, &'static str> {
    match v.and_then(|v| v.as_str()) {
        Some("username") => Ok("username"),
        Some("password") => Ok("password"),
        Some("code") => Ok("code"),
        _ => Err("bad_request"),
    }
}

fn popup_host(req: &Value) -> Result<String, &'static str> {
    let host = req.get("host").and_then(|v| v.as_str()).ok_or("bad_request")?;
    if !valid_host(host) {
        return Err("bad_host");
    }
    Ok(host.to_string())
}

fn required_account(req: &Value) -> Result<String, &'static str> {
    validate_account(req.get("account"))?.ok_or("bad_request")
}

/// `{op:"list", host}` → the host.
pub fn validate_list(req: &Value) -> Result<String, &'static str> {
    popup_host(req)
}

/// `{op:"copy", host, account, what}` → `(host, account, what)`.
pub fn validate_copy(req: &Value) -> Result<(String, String, &'static str), &'static str> {
    Ok((popup_host(req)?, required_account(req)?, validate_copy_what(req.get("what"))?))
}

/// `{op:"open", host, account}` → `(host, account)`.
pub fn validate_open(req: &Value) -> Result<(String, String), &'static str> {
    Ok((popup_host(req)?, required_account(req)?))
}

/// `{error}` of a UI reply as a short word (no free text reaches the extension), or `None` when it has none.
fn error_reply(reply: &Value) -> Option<Value> {
    reply.get("error").map(|e| {
        let word: String =
            e.as_str().unwrap_or("").chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect();
        json!({ "error": if word.is_empty() { "failed".to_string() } else { word } })
    })
}

/// The UI's `list` answer, reduced to what the extension may see: account ids, titles and usernames (each
/// length-capped, control characters removed), whether a 2FA code exists, at most [`MAX_LIST`] entries.
pub fn sanitize_list_reply(reply: &Value) -> Value {
    if let Some(e) = error_reply(reply) {
        return e;
    }
    let ok = reply.get("ok") == Some(&json!(true));
    let Some(list) = reply.get("accounts").and_then(|a| a.as_array()).filter(|_| ok) else {
        return json!({ "error": "failed" });
    };
    let cap = |v: Option<&Value>, n: usize| clean(v.and_then(|v| v.as_str()).unwrap_or("")).chars().take(n).collect::<String>();
    let accounts: Vec<Value> = list
        .iter()
        .filter_map(|a| {
            let account = validate_account(a.get("account")).ok().flatten()?;
            Some(json!({
                "account": account,
                "title": cap(a.get("title"), 200),
                "username": cap(a.get("username"), 512),
                "totp": a.get("totp") == Some(&json!(true)),
            }))
        })
        .take(MAX_LIST)
        .collect();
    json!({ "ok": true, "accounts": accounts })
}

/// The UI's `copy` answer, reduced to `{ok, copied, clearAfter}` (seconds, 0 = never) or `{error}`: whatever
/// else the UI put in it (it never should hold the value) does not reach the extension.
pub fn sanitize_copy_reply(reply: &Value, what: &str) -> Value {
    if let Some(e) = error_reply(reply) {
        return e;
    }
    if reply.get("ok") != Some(&json!(true)) {
        return json!({ "error": "failed" });
    }
    let clear = reply.get("clearAfter").and_then(|v| v.as_u64()).filter(|&n| n <= 3600).unwrap_or(0);
    json!({ "ok": true, "copied": what, "clearAfter": clear })
}

/// The popup ops; `None` for every other op.
fn handle_popup(app: &AppHandle, op: &str, req: &Value) -> Option<Value> {
    if !matches!(op, "list" | "copy" | "open") {
        return None;
    }
    touch_extension();
    let unlocked = || app.state::<crate::vault::VaultState>().is_unlocked();
    let (host, reply) = match op {
        "list" => match validate_list(req) {
            Err(e) => return Some(json!({ "error": e })),
            Ok(host) if !unlocked() => (host, json!({ "error": "locked" })),
            Ok(host) => {
                let r = await_ui(app, LIST_EVENT, json!({ "host": host }), false);
                (host, sanitize_list_reply(&r))
            }
        },
        "copy" => match validate_copy(req) {
            Err(e) => return Some(json!({ "error": e })),
            // The username is not behind an Allow, so it needs a vault that is already open.
            Ok((host, _, "username")) if !unlocked() => (host, json!({ "error": "locked" })),
            Ok((host, account, what)) => {
                let r = await_ui(app, COPY_EVENT, json!({ "host": host, "account": account, "what": what }), false);
                (host, sanitize_copy_reply(&r, what))
            }
        },
        _ => match validate_open(req) {
            Err(e) => return Some(json!({ "error": e })),
            Ok((host, account)) => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.unminimize();
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let r = match app.emit_to("main", OPEN_ENTRY_EVENT, json!({ "rel": account })) {
                    Ok(()) => json!({ "ok": true }),
                    Err(_) => json!({ "error": "failed" }),
                };
                (host, r)
            }
        },
    };
    record_request(&host, &reply);
    Some(reply)
}

/// The native host was started by the browser, which is in front while its popup is open: let the app take the
/// foreground for `open` (Windows otherwise only flashes its taskbar button).
#[cfg(windows)]
fn allow_app_foreground() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};
    // SAFETY: plain call without pointers; failure only means the app may not come to the front.
    unsafe {
        AllowSetForegroundWindow(ASFW_ANY);
    }
}
#[cfg(not(windows))]
fn allow_app_foreground() {}

/// The UI's autofill listeners are registered. Requests that arrive earlier wait briefly for it
/// (an app launched by the extension receives the request while its webview is still loading).
/// Called by the autofill prompt window and by the main window (which only handles fallback requests).
#[tauri::command]
pub fn autofill_ui_ready(window: tauri::Window) {
    if window.label() == PROMPT_LABEL {
        PROMPT_READY.store(true, Ordering::Release);
    } else {
        UI_READY.store(true, Ordering::Release);
    }
}

fn wait_for(flag: &AtomicBool, limit: Duration) -> bool {
    let start = Instant::now();
    while !flag.load(Ordering::Acquire) {
        if start.elapsed() >= limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    true
}

// ─── The autofill prompt window ──────────────────────────────────────────────
//
// Approval happens in a small, separate, always-on-top window (label `autofill-prompt`, route
// `#/autofill-prompt`): the main window is never raised. The window is created hidden on the first
// request and then kept alive (hidden) so the per-site trust window kept in its JS survives. Its JS
// decides whether the user is needed at all: a trusted site, no match or an unchanged save is
// answered without the window ever being shown. Only when it needs the user does it call
// `autofill_prompt_show`; after the answer it calls `autofill_prompt_hide`, which hands the focus
// back to the window that had it (normally the browser).
//
// If the window can't be created (or never reports ready), the request falls back to the old way:
// the main window is shown and gets the same event with `"fallback": true`.

pub const PROMPT_LABEL: &str = "autofill-prompt";
/// Emitted to the prompt window when Rust stops waiting for a request (`{id}`): drop it.
const CANCEL_EVENT: &str = "autofill:cancel";
/// Emitted to the prompt window when the user closes it (Alt+F4): answer the open request with Deny.
pub const DISMISS_EVENT: &str = "autofill-prompt:dismiss";
/// Set once the prompt window listens for requests.
static PROMPT_READY: AtomicBool = AtomicBool::new(false);
/// How long a request waits for a freshly created prompt window to load before falling back.
const PROMPT_READY_WAIT: Duration = Duration::from_secs(10);
/// Requests waiting for an answer at the same time; more are refused with `denied` right away.
const MAX_PENDING: usize = 4;

/// May one more request wait for the UI, given how many already do?
pub fn admit(pending: usize, max: usize) -> bool {
    pending < max
}

/// The prompt window's fixed settings (pure, so they can be tested).
#[derive(Debug, Clone, PartialEq)]
pub struct PromptWindowConfig {
    pub label: &'static str,
    pub url: &'static str,
    pub title: &'static str,
    /// Logical size before the page measures itself.
    pub width: f64,
    pub height: f64,
    pub resizable: bool,
    pub decorations: bool,
    pub shadow: bool,
    pub always_on_top: bool,
    pub skip_taskbar: bool,
    pub visible: bool,
    pub focused: bool,
}

pub fn prompt_window_config(is_dev: bool) -> PromptWindowConfig {
    PromptWindowConfig {
        label: PROMPT_LABEL,
        url: "index.html#/autofill-prompt",
        title: if is_dev { "Notiq Dev Autofill" } else { "Notiq Autofill" },
        width: 420.0,
        height: 240.0,
        resizable: false,
        decorations: false,
        shadow: true,
        always_on_top: true,
        skip_taskbar: true,
        visible: false,
        focused: false,
    }
}

/// The payload the main window gets when it has to handle a request itself.
pub fn with_fallback_flag(mut payload: Value) -> Value {
    payload["fallback"] = json!(true);
    payload
}

/// Top-left corner that centres a `win`-sized window in a monitor's area (all physical pixels).
/// A window larger than the area is pinned to its top-left corner instead of going off-screen.
pub fn centered(area_pos: (i32, i32), area_size: (u32, u32), win: (u32, u32)) -> (i32, i32) {
    let off = |a: u32, w: u32| (a.saturating_sub(w) / 2) as i32;
    (area_pos.0 + off(area_size.0, win.0), area_pos.1 + off(area_size.1, win.1))
}

/// Creates the prompt window (hidden) unless it exists, and waits until its page listens.
fn ensure_prompt(app: &AppHandle) -> Result<(), String> {
    static CREATING: Mutex<()> = Mutex::new(());
    let _one_at_a_time = CREATING.lock().unwrap_or_else(|e| e.into_inner());
    if app.get_webview_window(PROMPT_LABEL).is_none() {
        PROMPT_READY.store(false, Ordering::Release);
        let c = prompt_window_config(crate::profile::IS_DEV);
        tauri::WebviewWindowBuilder::new(app, c.label, tauri::WebviewUrl::App(c.url.into()))
            .title(c.title)
            .inner_size(c.width, c.height)
            .resizable(c.resizable)
            .maximizable(false)
            .minimizable(false)
            .decorations(c.decorations)
            .shadow(c.shadow)
            .always_on_top(c.always_on_top)
            .skip_taskbar(c.skip_taskbar)
            .visible(c.visible)
            .focused(c.focused)
            .background_color(tauri::window::Color(15, 23, 42, 255))
            .center()
            .build()
            .map_err(|e| e.to_string())?;
    }
    if wait_for(&PROMPT_READY, PROMPT_READY_WAIT) { Ok(()) } else { Err("the prompt window did not load".into()) }
}

fn hide_prompt(app: &AppHandle, restore: bool) {
    let Some(w) = app.get_webview_window(PROMPT_LABEL) else { return };
    // Only hand the focus back when the prompt still has it (the user may have moved on meanwhile).
    let had_focus = w.is_focused().unwrap_or(false);
    let _ = w.hide();
    let prev = take_prev_foreground();
    if restore && had_focus {
        restore_foreground(prev);
    }
}

/// Registers a pending id, routes `event` to the prompt window (or, failing that, the main window)
/// and waits for the reply. Nothing is shown or focused here: the prompt window shows itself only
/// when it needs the user. Without `allow_fallback` an unavailable prompt window answers `failed` at once.
fn await_ui(app: &AppHandle, event: &str, mut payload: Value, allow_fallback: bool) -> Value {
    let id = random_token();
    payload["id"] = json!(id);
    let (tx, rx) = channel();
    {
        let mut p = pending().lock().unwrap_or_else(|e| e.into_inner());
        if !admit(p.len(), MAX_PENDING) {
            return json!({ "error": "denied" });
        }
        p.insert(id.clone(), tx);
    }

    let routed = ensure_prompt(app).and_then(|()| app.emit_to(PROMPT_LABEL, event, payload.clone()).map_err(|e| e.to_string()));
    let fallback = match routed {
        Ok(()) => None,
        Err(e) if !allow_fallback => {
            eprintln!("autofill: prompt window unavailable ({e})");
            pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
            return json!({ "error": "failed" });
        }
        Err(e) => {
            eprintln!("autofill: prompt window unavailable ({e}); using the main window");
            Some(fallback_to_main(app, event, payload))
        }
    };

    let reply = rx.recv_timeout(ANSWER_TIMEOUT);
    let left = {
        let mut p = pending().lock().unwrap_or_else(|e| e.into_inner());
        p.remove(&id);
        p.len()
    };
    let reply = reply.unwrap_or_else(|_| {
        // Nobody answered in time: tell the UI to drop the request, and hide the prompt if it was the last one.
        let target = if fallback.is_some() { "main" } else { PROMPT_LABEL };
        let _ = app.emit_to(target, CANCEL_EVENT, json!({ "id": id }));
        if fallback.is_none() && left == 0 {
            hide_prompt(app, true);
        }
        json!({ "error": "timeout" })
    });
    if let Some(f) = fallback {
        f.finish();
    }
    reply
}

/// The old way, used only when the prompt window is unavailable: raise the main window and let it ask.
struct MainFallback {
    win: Option<tauri::WebviewWindow>,
    was_minimized: bool,
    browser: Foreground,
}

impl MainFallback {
    fn finish(self) {
        if self.was_minimized {
            if let Some(w) = &self.win { let _ = w.minimize(); }
        }
        restore_foreground(self.browser);
    }
}

fn fallback_to_main(app: &AppHandle, event: &str, payload: Value) -> MainFallback {
    let win = app.get_webview_window("main");
    let was_minimized = win.as_ref().and_then(|w| w.is_minimized().ok()).unwrap_or(false);
    let browser = foreground_window();
    if let Some(w) = &win {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    wait_for(&UI_READY, Duration::from_secs(20));
    let _ = app.emit_to("main", event, with_fallback_flag(payload));
    MainFallback { win, was_minimized, browser }
}

/// The prompt window needs the user: centre it on the monitor under the mouse pointer (where the user
/// just clicked Fill), keep it above everything, show it and give it the keyboard focus.
#[tauri::command]
pub fn autofill_prompt_show(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window(PROMPT_LABEL).ok_or("The autofill window is gone")?;
    remember_prev_foreground(&w);
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| w.current_monitor().ok().flatten())
        .or_else(|| w.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let area = m.work_area();
        let (pos, size) = ((area.position.x, area.position.y), (area.size.width, area.size.height));
        // Move onto the monitor first: crossing to a monitor with another scale factor resizes the window.
        let _ = w.set_position(tauri::PhysicalPosition::new(pos.0, pos.1));
        if let Ok(s) = w.outer_size() {
            let (x, y) = centered(pos, size, (s.width, s.height));
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    } else {
        let _ = w.center();
    }
    let _ = w.set_always_on_top(true);
    let _ = w.show();
    let _ = w.unminimize();
    w.set_focus().map_err(|e| e.to_string())
}

/// Hides the prompt window; `restore` hands the focus back to the window that had it before.
#[tauri::command]
pub fn autofill_prompt_hide(app: AppHandle, restore: bool) {
    hide_prompt(&app, restore);
}

/// The window that had the focus when the request arrived (normally the browser).
#[cfg(windows)]
type Foreground = windows_sys::Win32::Foundation::HWND;
#[cfg(not(windows))]
type Foreground = ();

#[cfg(windows)]
fn foreground_window() -> Foreground {
    // SAFETY: plain query with no arguments.
    unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() }
}
#[cfg(not(windows))]
fn foreground_window() -> Foreground {}

/// Hands the focus back to `prev` (our process is the foreground one at this point, so Windows allows it).
#[cfg(windows)]
fn restore_foreground(prev: Foreground) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    // SAFETY: both calls only read/act on a window handle and tolerate stale handles (checked with IsWindow).
    unsafe {
        if !prev.is_null() && IsWindow(prev) != 0 {
            SetForegroundWindow(prev);
        }
    }
}
#[cfg(not(windows))]
fn restore_foreground(_prev: Foreground) {}

/// The window that was in front when the prompt was shown (raw HWND; 0 = none).
#[cfg(windows)]
static PREV_FOREGROUND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

/// Remembers the current foreground window, unless it is the prompt itself (shown twice in a row).
#[cfg(windows)]
fn remember_prev_foreground(prompt: &tauri::WebviewWindow) {
    let h = foreground_window();
    let ours = prompt.hwnd().map(|w| w.0 as isize == h as isize).unwrap_or(false);
    if !ours {
        PREV_FOREGROUND.store(h as isize, Ordering::Release);
    }
}
#[cfg(not(windows))]
fn remember_prev_foreground(_prompt: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn take_prev_foreground() -> Foreground {
    PREV_FOREGROUND.swap(0, Ordering::AcqRel) as Foreground
}
#[cfg(not(windows))]
fn take_prev_foreground() -> Foreground {}

/// The UI answers a request (allowed credentials, a `choose` list, or an error such as `denied`).
#[tauri::command]
pub fn autofill_reply(id: String, payload: Value) {
    if let Some(tx) = pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let _ = tx.send(payload);
    }
}

// ─── Native host (bare process started by the browser) ───────────────────────

/// True when the browser launched us for native messaging.
pub fn is_native_host_launch() -> bool {
    std::env::args()
        .skip(1)
        .any(|a| a.starts_with("chrome-extension://") || a == "--native-host" || FIREFOX_EXTENSION_IDS.contains(&a.as_str()))
}

/// Bridges the browser's framed stdio to the app. Never returns normally.
pub fn run_native_host() {
    // Only our own extension may talk to us.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !origin_allowed(&args, &known_extension_ids()) {
        return;
    }
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut conn: Option<Conn> = None;

    loop {
        let mut len = [0u8; 4];
        if stdin.read_exact(&mut len).is_err() {
            return;
        }
        let n = u32::from_le_bytes(len) as usize;
        if n == 0 || n > MAX_MSG {
            return;
        }
        let mut buf = vec![0u8; n];
        if stdin.read_exact(&mut buf).is_err() {
            return;
        }
        let reply = match serde_json::from_slice::<Value>(&buf) {
            Ok(req) => forward(&mut conn, &req),
            Err(_) => json!({ "error": "bad_json" }),
        };
        let bytes = reply.to_string().into_bytes();
        if stdout.write_all(&(bytes.len() as u32).to_le_bytes()).is_err()
            || stdout.write_all(&bytes).is_err()
            || stdout.flush().is_err()
        {
            return;
        }
    }
}

type Conn = (TcpStream, BufReader<TcpStream>);

/// Connects to the running app and proves it is alive: token handshake, then a `hello` that must be answered with
/// a JSON object. A stale `autofill_ipc.json` (app gone; port closed or reused by something else) fails here.
fn connect() -> Option<Conn> {
    let raw = std::fs::read_to_string(data_dir_plain()?.join(IPC_FILE)).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let port = u16::try_from(v.get("port")?.as_u64()?).ok()?;
    let token = v.get("token")?.as_str()?.to_string();
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    writeln!(s, "{}", json!({ "token": token })).ok()?;
    writeln!(s, "{}", json!({ "op": "hello" })).ok()?;
    let mut r = BufReader::new(s.try_clone().ok()?);
    let mut line = String::new();
    r.read_line(&mut line).ok()?;
    serde_json::from_str::<Value>(line.trim()).ok().filter(|v| v.is_object())?;
    // Replies are read through the clone, and on Windows a cloned socket keeps its own timeout: set it there,
    // or every answer that needs the user (> 3 s) fails and the request is sent twice.
    r.get_ref().set_read_timeout(Some(ANSWER_TIMEOUT + Duration::from_secs(10))).ok()?;
    Some((s, r))
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock)
}

/// Ops that may start Notiq when it isn't running (a user action in the browser). `ping` and `theme` never do.
fn may_launch(op: &str) -> bool {
    matches!(op, "fill" | "fill_card" | "fill_identity" | "save" | "launch")
}

// ─── Theme shared with the extension ─────────────────────────────────────────

const THEME_FILE: &str = "autofill-theme.json";
const THEME_MAX_BYTES: usize = 2048;
const THEME_COLOR_KEYS: [&str; 9] =
    ["bg", "bgSecondary", "bgTertiary", "text", "textMuted", "border", "primary", "primaryText", "danger"];

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// Validates a theme object (`id`, `mode`, and every colour `#rrggbb`). Returns a normalised copy with only known keys.
pub fn validate_theme(v: &Value) -> Option<Value> {
    let o = v.as_object()?;
    let id = o.get("id")?.as_str()?;
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return None;
    }
    let mode = o.get("mode")?.as_str()?;
    if mode != "dark" && mode != "light" {
        return None;
    }
    let mut out = serde_json::Map::new();
    out.insert("id".into(), json!(id));
    out.insert("mode".into(), json!(mode));
    for k in THEME_COLOR_KEYS.iter().chain(std::iter::once(&"success")) {
        let c = o.get(*k)?.as_str()?;
        if !is_hex_color(c) {
            return None;
        }
        out.insert((*k).into(), json!(c));
    }
    Some(Value::Object(out))
}

/// Parses and validates the stored theme document (size-capped).
pub fn parse_theme_doc(raw: &str) -> Option<Value> {
    if raw.len() > THEME_MAX_BYTES {
        return None;
    }
    validate_theme(&serde_json::from_str::<Value>(raw).ok()?)
}

/// The `theme` op: the exported theme, or `null`. Never needs the app, the vault or the IPC token.
fn theme_reply() -> Value {
    let theme = data_dir_plain()
        .and_then(|d| std::fs::read_to_string(d.join(THEME_FILE)).ok())
        .and_then(|raw| parse_theme_doc(&raw));
    json!({ "ok": true, "theme": theme })
}

/// Called by the main window whenever the theme changes; stores it for the browser extension (not secret).
#[tauri::command]
pub fn autofill_set_theme(theme: Value) -> Result<(), String> {
    let t = validate_theme(&theme).ok_or("bad_theme")?;
    let dir = data_dir_plain().ok_or("no_data_dir")?;
    atomic_write(&dir.join(THEME_FILE), t.to_string().as_bytes())
}

fn forward(conn: &mut Option<Conn>, req: &Value) -> Value {
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    if op == "theme" {
        return theme_reply();
    }
    if op == "open" {
        allow_app_foreground();
    }
    for attempt in 0..2 {
        if conn.is_none() {
            *conn = connect();
        }
        if conn.is_none() && may_launch(op) {
            *conn = launch_and_wait();
        }
        let Some((w, r)) = conn.as_mut() else {
            return json!({ "error": "app_not_running" });
        };
        if op == "launch" {
            return json!({ "ok": true });
        }
        let mut line = String::new();
        let read = if writeln!(w, "{req}").is_ok() { r.read_line(&mut line) } else { Ok(0) };
        match read {
            Ok(n) if n > 0 => {
                return serde_json::from_str(line.trim()).unwrap_or_else(|_| json!({ "error": "bad_reply" }));
            }
            // The app has the request and is still waiting for the user: sending it again would ask twice.
            Err(e) if is_timeout(&e) => return json!({ "error": "timeout" }),
            _ => {}
        }
        *conn = None; // stale connection (app restarted) — reconnect once
        if attempt == 1 {
            break;
        }
    }
    json!({ "error": "app_not_running" })
}

// ─── Starting Notiq from the native host ─────────────────────────────────────

/// May a host start the app now, given the time of the last launch attempt (from the lock file)?
/// A timestamp far in the future (clock change) is ignored.
pub fn launch_allowed(prev_ms: Option<u64>, now_ms: u64, backoff_ms: u64) -> bool {
    match prev_ms {
        None => true,
        Some(p) if p > now_ms => p - now_ms > backoff_ms,
        Some(p) => now_ms - p >= backoff_ms,
    }
}

/// Poll delays while waiting for a launched app: 150 ms growing ×1.5 up to 1 s, summing to exactly `total`.
pub fn poll_delays(total: Duration) -> Vec<Duration> {
    let mut out = Vec::new();
    let mut sum = Duration::ZERO;
    let mut d = Duration::from_millis(150);
    while sum + d <= total {
        out.push(d);
        sum += d;
        d = (d * 3 / 2).min(Duration::from_secs(1));
    }
    if sum < total {
        out.push(total - sum);
    }
    out
}

/// Claims the launch lock. Of several concurrent hosts exactly one gets `true` (`create_new` is atomic);
/// a lock older than the backoff window (or unreadable) is replaced.
fn claim_launch(dir: &std::path::Path, now: u64) -> bool {
    use std::fs::OpenOptions;
    let path = dir.join(LAUNCH_LOCK);
    let _ = std::fs::create_dir_all(dir);
    for _ in 0..2 {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut f) => {
                let _ = write!(f, "{now}");
                return true;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let prev = std::fs::read_to_string(&path).ok().and_then(|s| s.trim().parse::<u64>().ok());
                if !launch_allowed(prev, now, LAUNCH_BACKOFF_MS) {
                    return false;
                }
                let _ = std::fs::remove_file(&path); // stale: retry the atomic create once
            }
            Err(_) => return false,
        }
    }
    false
}

/// Starts this exe as a normal tray app: `--hidden` (no browser-origin argument, so it is not a host), detached,
/// with no inherited stdio (our stdout is the browser's pipe).
fn spawn_app() -> bool {
    use std::process::{Command, Stdio};
    let Ok(exe) = std::env::current_exe() else { return false };
    let build = || {
        let mut c = Command::new(&exe);
        c.arg("--hidden").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        if let Some(d) = exe.parent() {
            c.current_dir(d);
        }
        c
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        // The browser may run hosts in a job object that dies with the host; break away when the job allows it.
        let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
        if build().creation_flags(base | CREATE_BREAKAWAY_FROM_JOB).spawn().is_ok() {
            return true;
        }
        build().creation_flags(base).spawn().is_ok()
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        build().process_group(0).spawn().is_ok()
    }
    #[cfg(not(any(windows, unix)))]
    {
        build().spawn().is_ok()
    }
}

/// The app isn't reachable: start it (unless another host just did) and wait up to `LAUNCH_WAIT` for it to answer.
fn launch_and_wait() -> Option<Conn> {
    let dir = data_dir_plain()?;
    if claim_launch(&dir, now_ms()) && !spawn_app() {
        return None;
    }
    let start = Instant::now();
    for d in poll_delays(LAUNCH_WAIT) {
        std::thread::sleep(d);
        if let Some(c) = connect() {
            return Some(c);
        }
        if start.elapsed() >= LAUNCH_WAIT {
            break;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_time_compare() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "ab"));
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = random_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, random_token());
    }

    #[test]
    fn extension_ids() {
        assert!(valid_extension_id("cfddmbiaaboejbhnijkjodcganjdbcel"));
        assert!(!valid_extension_id("cfddmbiaaboejbhnijkjodcganjdbcez"));
        assert!(!valid_extension_id("CFDDMBIAABOEJBHNIJKJODCGANJDBCEL"));
        assert!(!valid_extension_id(""));
        let base = merge_extension_ids(None);
        assert_eq!(base, vec!["cfddmbiaaboejbhnijkjodcganjdbcel".to_string()]); // empty slots skipped
        let extra = r#"["abcdefghijklmnopabcdefghijklmnop", "bad", 7, "cfddmbiaaboejbhnijkjodcganjdbcel", "../x"]"#;
        assert_eq!(merge_extension_ids(Some(extra)), vec!["cfddmbiaaboejbhnijkjodcganjdbcel", "abcdefghijklmnopabcdefghijklmnop"]);
        assert_eq!(merge_extension_ids(Some("{not json")), base);
        assert_eq!(merge_extension_ids(Some(r#"{"ids":[]}"#)), base);
    }

    #[test]
    fn origin_check_uses_whole_list() {
        let ids = vec!["cfddmbiaaboejbhnijkjodcganjdbcel".to_string(), "abcdefghijklmnopabcdefghijklmnop".to_string()];
        let a = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(origin_allowed(&a(&["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]), &ids));
        assert!(origin_allowed(&a(&["chrome-extension://cfddmbiaaboejbhnijkjodcganjdbcel/", "--parent-window=0"]), &ids));
        assert!(origin_allowed(&a(&["/home/u/.mozilla/native-messaging-hosts/com.trexolab.notiq.json", "autofill@notiq.app"]), &ids));
        assert!(!origin_allowed(&a(&["chrome-extension://pppppppppppppppppppppppppppppppp/"]), &ids));
        assert!(!origin_allowed(&a(&["chrome-extension://abcdefghijklmnopabcdefghijklmnop"]), &ids));
        assert!(!origin_allowed(&a(&[]), &ids));
    }

    #[test]
    fn account_validation() {
        assert_eq!(validate_account(None), Ok(None));
        assert_eq!(validate_account(Some(&json!(null))), Ok(None));
        assert_eq!(validate_account(Some(&json!(""))), Ok(None));
        assert_eq!(validate_account(Some(&json!("Logins/Example.nqv"))), Ok(Some("Logins/Example.nqv".into())));
        for bad in [
            json!("../x.nqv"),
            json!("Logins/../../x"),
            json!("a\u{0007}b"),
            json!("/abs.nqv"),
            json!("\\\\server\\x"),
            json!("C:\\x.nqv"),
            json!("x".repeat(513)),
            json!(5),
            json!(["a"]),
        ] {
            assert_eq!(validate_account(Some(&bad)), Err("bad_request"), "{bad}");
        }
        assert!(validate_account(Some(&json!("y".repeat(512)))).is_ok());
    }

    #[test]
    fn intent_validation() {
        assert_eq!(validate_intent(None), Ok(None));
        assert_eq!(validate_intent(Some(&json!(null))), Ok(None));
        assert_eq!(validate_intent(Some(&json!("code"))), Ok(Some("code")));
        for bad in [json!(""), json!("password"), json!("CODE"), json!(1), json!(true), json!(["code"]), json!({})] {
            assert_eq!(validate_intent(Some(&bad)), Err("bad_request"), "{bad}");
        }
    }

    #[test]
    fn outcomes_hold_no_secrets() {
        assert_eq!(outcome_of(&json!({"ok":true,"username":"me","password":"pw"})), "ok");
        assert_eq!(outcome_of(&json!({"error":"denied"})), "denied");
        assert_eq!(outcome_of(&json!({"ok":true,"status":"updated"})), "updated");
        assert_eq!(outcome_of(&json!({"choose":[{"account":"a","title":"t","username":"u"}]})), "choose");
        assert_eq!(outcome_of(&json!({"error":"<script>x</script>"})), "scriptxscript");
    }

    #[test]
    fn launch_backoff() {
        assert!(launch_allowed(None, 1_000, 15_000));
        assert!(!launch_allowed(Some(1_000), 5_000, 15_000));
        assert!(launch_allowed(Some(1_000), 16_000, 15_000));
        assert!(!launch_allowed(Some(20_000), 10_000, 15_000)); // slightly in the future: still blocked
        assert!(launch_allowed(Some(100_000), 10_000, 15_000)); // far future (clock change): ignored
        assert!(launch_allowed(Some(0), u64::MAX, 15_000));
    }

    #[test]
    fn poll_schedule() {
        let d = poll_delays(Duration::from_secs(12));
        let total: Duration = d.iter().sum();
        assert_eq!(total, Duration::from_secs(12));
        assert_eq!(d[0], Duration::from_millis(150));
        assert!(d.windows(2).take(5).all(|w| w[1] >= w[0]));
        assert!(d.iter().all(|x| *x <= Duration::from_secs(1)));
        assert!(poll_delays(Duration::ZERO).is_empty());
        assert_eq!(poll_delays(Duration::from_millis(100)), vec![Duration::from_millis(100)]);
    }

    #[test]
    fn launch_lock_lets_one_host_through() {
        let dir = std::env::temp_dir().join(format!("notiq-launch-test-{}", random_token()));
        let now = now_ms();
        assert!(claim_launch(&dir, now));
        assert!(!claim_launch(&dir, now + 1_000)); // concurrent / quick retry: no second launch
        assert!(claim_launch(&dir, now + LAUNCH_BACKOFF_MS + 1)); // stale lock replaced
        std::fs::write(dir.join(LAUNCH_LOCK), "garbage").unwrap();
        assert!(claim_launch(&dir, now)); // unreadable lock is treated as stale
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fill_identity_uses_the_card_origin_rule_and_an_optional_account() {
        let req = |v: Value| validate_fill_identity(&v);
        assert_eq!(
            req(json!({ "op": "fill_identity", "host": "shop.example.in", "origin": "https://shop.example.in" })),
            Ok(("shop.example.in".into(), None))
        );
        assert_eq!(
            req(json!({ "host": "localhost", "origin": "http://localhost:8000", "account": "Identities/Home.nqv" })),
            Ok(("localhost".into(), Some("Identities/Home.nqv".into())))
        );
        assert_eq!(req(json!({ "host": "a.com", "origin": "https://a.com", "account": "" })), Ok(("a.com".into(), None)));
        assert_eq!(req(json!({ "host": "a.com", "origin": "http://a.com" })), Err("not_https"));
        assert_eq!(req(json!({ "host": "a.com", "origin": "https://b.com" })), Err("bad_request"));
        assert_eq!(req(json!({ "host": "A.com", "origin": "https://a.com" })), Err("bad_host"));
        for bad in [json!("../x.nqv"), json!("/abs.nqv"), json!("C:x"), json!(5), json!("a\u{1}b")] {
            assert_eq!(req(json!({ "host": "a.com", "origin": "https://a.com", "account": bad })), Err("bad_request"));
        }
    }

    #[test]
    fn identities_reply_lists_identity_titles_only() {
        let item = |rel: &str, ext: &str, dir: bool, trashed: bool| crate::vault_db::ListItem {
            rel: rel.into(), ext: ext.into(), updated: 0, dir, tags: vec![], starred: false,
            trashed_at: if trashed { Some(1) } else { None }, attachments: 0, history: 0,
        };
        let items = vec![
            item("Identities/Office.nqv", "identity", false, false),
            item("home.NQV", "identity", false, false),
            item("Logins/bank.nqv", "login", false, false),
            item("Cards/visa.nqv", "card", false, false),
            item("Identities", "identity", true, false),
            item("Old.nqv", "identity", false, true),
            item("x/..evil.nqv", "identity", false, false),
            item("Bad\u{7}Name.nqv", "identity", false, false),
        ];
        let r = identities_reply(&items);
        assert_eq!(r["ok"], json!(true));
        // Logins, cards, folders, trashed entries and unsafe paths are left out; sorted by title.
        assert_eq!(
            r["identities"],
            json!([
                { "account": "home.NQV", "title": "home" },
                { "account": "Identities/Office.nqv", "title": "Office" },
            ])
        );
        let many: Vec<_> = (0..30).map(|i| item(&format!("id{i:02}.nqv"), "identity", false, false)).collect();
        let r = identities_reply(&many);
        assert_eq!(r["identities"].as_array().unwrap().len(), MAX_IDENTITIES);
        assert_eq!(r["identities"][0], json!({ "account": "id00.nqv", "title": "id00" }));
        assert_eq!(identities_reply(&[]), json!({ "ok": true, "identities": [] }));
    }

    #[test]
    fn fill_card_accepts_secure_origins_only() {
        let req = |host: &str, origin: &str| json!({ "op": "fill_card", "host": host, "origin": origin });
        assert_eq!(validate_fill_card(&req("shop.example.com", "https://shop.example.com")), Ok("shop.example.com".into()));
        assert_eq!(validate_fill_card(&req("shop.example.com", "https://shop.example.com:8443")), Ok("shop.example.com".into()));
        assert!(validate_fill_card(&req("localhost", "http://localhost:3000")).is_ok());
        assert!(validate_fill_card(&req("127.0.0.1", "http://127.0.0.1")).is_ok());
        assert_eq!(validate_fill_card(&req("shop.example.com", "http://shop.example.com")), Err("not_https"));
        assert_eq!(validate_fill_card(&req("example.com", "javascript:alert(1)")), Err("not_https"));
        assert_eq!(validate_fill_card(&req("localhost.evil.com", "http://localhost.evil.com")), Err("not_https"));
        for (host, origin) in [
            ("shop.example.com", "https://evil.com"),
            ("example.com", "https://example.com.evil.com"),
            ("example.com", "https://example.com/"),
            ("example.com", "https://example.com:"),
            ("example.com", "https://example.com:123456"),
            ("example.com", "https://example.com:80x"),
        ] {
            assert_eq!(validate_fill_card(&req(host, origin)), Err("bad_request"), "{origin}");
        }
        for host in ["", "Example.com", "a.com:8080", "[::1]", &"a".repeat(254)] {
            assert_eq!(validate_fill_card(&req(host, "https://x")), Err("bad_host"), "{host}");
        }
        let long = format!("https://example.com:{}", "1".repeat(300));
        assert_eq!(validate_fill_card(&req("example.com", &long)), Err("bad_request"));
        assert_eq!(validate_fill_card(&json!({ "op": "fill_card", "host": "example.com" })), Err("bad_request"));
        assert_eq!(validate_fill_card(&json!({ "op": "fill_card", "origin": "https://example.com" })), Err("bad_request"));
        assert_eq!(validate_fill_card(&json!({ "op": "fill_card", "host": 5, "origin": "https://x" })), Err("bad_request"));
    }

    #[test]
    fn protocol_versions() {
        // Missing / null = an extension from before protocol 2.
        assert_eq!(request_protocol(&json!({ "op": "fill" })), Ok(1));
        assert_eq!(request_protocol(&json!({ "op": "fill", "protocol": null })), Ok(1));
        assert_eq!(request_protocol(&json!({ "op": "fill", "protocol": 2 })), Ok(2));
        for bad in [json!(0), json!(-1), json!(1.5), json!("2"), json!([2]), json!({})] {
            assert_eq!(request_protocol(&json!({ "op": "fill", "protocol": bad })), Err("bad_request"), "{bad}");
        }
        // The current extension and every older one down to the minimum are served; protocol 0 never is.
        assert!((1..=PROTOCOL).contains(&MIN_EXTENSION_PROTOCOL));
        assert!(extension_supported(PROTOCOL) && extension_supported(PROTOCOL + 1));
        assert!(extension_supported(MIN_EXTENSION_PROTOCOL));
        assert!(!extension_supported(MIN_EXTENSION_PROTOCOL - 1));
        // Extensions that predate the field still work while MIN_EXTENSION_PROTOCOL is 1.
        if MIN_EXTENSION_PROTOCOL == 1 {
            assert_eq!(protocol_gate(&json!({ "op": "fill", "host": "example.com" }), "0.9.0"), None);
        }
        assert_eq!(protocol_gate(&json!({ "op": "fill", "protocol": PROTOCOL, "ext": "0.5.0" }), "0.9.0"), None);
        assert_eq!(protocol_gate(&json!({ "op": "save", "protocol": "x" }), "0.9.0"), Some(json!({ "error": "bad_request" })));
    }

    #[test]
    fn outdated_extension_reply() {
        // Exercised with the real minimum when it is above 1; the reply shape is checked either way.
        let below = MIN_EXTENSION_PROTOCOL - 1;
        if below > 0 {
            let r = protocol_gate(&json!({ "op": "fill", "protocol": below }), "9.9.9").unwrap();
            assert_eq!(r, json!({ "error": "extension_outdated", "appVersion": "9.9.9", "minProtocol": MIN_EXTENSION_PROTOCOL }));
        }
        assert_eq!(outcome_of(&json!({ "error": "extension_outdated" })), "extension_outdated");
    }

    #[test]
    fn ping_reports_version_lock_state_and_protocol() {
        let r = ping_reply("0.9.0", true);
        assert_eq!(
            r,
            json!({ "ok": true, "appVersion": "0.9.0", "locked": true, "protocol": PROTOCOL, "minProtocol": MIN_EXTENSION_PROTOCOL })
        );
        assert_eq!(ping_reply("0.9.0", false)["locked"], false);
        assert_eq!(outcome_of(&r), "ok");
    }

    #[test]
    fn protocol_matches_the_extension() {
        let shared = include_str!("../../browser-extension/shared.js");
        let num = |name: &str| -> u64 {
            let key = format!("const {name} = ");
            let at = shared.find(&key).expect(name) + key.len();
            shared[at..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().expect(name)
        };
        assert_eq!(num("PROTOCOL"), PROTOCOL, "bump both sides together");
        assert!(PROTOCOL >= num("MIN_APP_PROTOCOL"), "this app is too old for the bundled extension");
        assert!(num("PROTOCOL") >= MIN_EXTENSION_PROTOCOL, "the bundled extension is too old for this app");
    }

    #[test]
    fn may_launch_only_for_user_actions() {
        assert!(may_launch("fill") && may_launch("fill_card") && may_launch("save") && may_launch("launch"));
        assert!(!may_launch("ping") && !may_launch("hello") && !may_launch("theme") && !may_launch(""));
        // A filled identity is a user action; listing titles for the menu never starts Notiq.
        assert!(may_launch("fill_identity") && !may_launch("identities"));
    }

    fn sample_theme() -> Value {
        json!({ "id": "one-dark", "mode": "dark", "bg": "#0f172a", "bgSecondary": "#1e293b", "bgTertiary": "#334155",
                "text": "#e2e8f0", "textMuted": "#64748b", "border": "#334155", "primary": "#c9a84c",
                "primaryText": "#0f172a", "danger": "#f87171", "success": "#4ade80" })
    }

    #[test]
    fn theme_validation() {
        assert_eq!(validate_theme(&sample_theme()), Some(sample_theme()));
        for (k, bad) in [("mode", json!("sepia")), ("bg", json!("red")), ("primary", json!("#fff")), ("id", json!("a b")),
                         ("id", json!("x".repeat(65))), ("danger", json!(5))] {
            let mut t = sample_theme();
            t[k] = bad;
            assert!(validate_theme(&t).is_none(), "{k}");
        }
        let mut t = sample_theme();
        t.as_object_mut().unwrap().remove("success");
        assert!(validate_theme(&t).is_none());
        assert!(validate_theme(&json!("x")).is_none());
        // unknown keys are dropped
        let mut t = sample_theme();
        t["extra"] = json!("<script>");
        assert_eq!(validate_theme(&t), Some(sample_theme()));
    }

    #[test]
    fn theme_doc_parsing_caps_size_and_rejects_garbage() {
        assert_eq!(parse_theme_doc(&sample_theme().to_string()), Some(sample_theme()));
        assert!(parse_theme_doc("not json").is_none());
        let mut big = sample_theme();
        big["pad"] = json!("x".repeat(THEME_MAX_BYTES));
        assert!(parse_theme_doc(&big.to_string()).is_none());
    }

    #[test]
    fn theme_op_never_needs_the_app() {
        let r = forward(&mut None, &json!({ "op": "theme" }));
        assert_eq!(r["ok"], json!(true));
        assert!(r.get("theme").is_some());
    }

    #[test]
    fn prompt_window_is_small_hidden_and_on_top() {
        let c = prompt_window_config(false);
        assert_eq!(c.label, "autofill-prompt");
        assert_eq!(c.url, "index.html#/autofill-prompt");
        assert_eq!(c.title, "Notiq Autofill");
        assert!(!c.visible && !c.focused, "created hidden and unfocused; it shows itself only when needed");
        assert!(c.always_on_top && c.skip_taskbar && c.shadow);
        assert!(!c.decorations && !c.resizable);
        assert!(c.width >= 360.0 && c.width <= 480.0 && c.height >= 160.0 && c.height <= 560.0);
        assert_eq!(prompt_window_config(true).title, "Notiq Dev Autofill");
        assert_eq!(prompt_window_config(true).label, c.label);
    }

    #[test]
    fn fallback_payload_is_flagged() {
        let p = with_fallback_flag(json!({"host":"example.com","id":"abc"}));
        assert_eq!(p, json!({"host":"example.com","id":"abc","fallback":true}));
        let s = with_fallback_flag(json!({"host":"a.io","url":"https://a.io","username":"u","password":"p","title":"","id":"x"}));
        assert_eq!(s["fallback"], json!(true));
        assert_eq!(s["password"], json!("p"));
    }

    #[test]
    fn queue_admits_up_to_the_limit() {
        assert!(admit(0, MAX_PENDING));
        assert!(admit(MAX_PENDING - 1, MAX_PENDING));
        assert!(!admit(MAX_PENDING, MAX_PENDING));
        assert!(!admit(MAX_PENDING + 3, MAX_PENDING));
        assert!(!admit(0, 0));
    }

    #[test]
    fn centring_on_a_monitor() {
        assert_eq!(centered((0, 0), (1920, 1040), (420, 240)), (750, 400));
        // Second monitor to the left, with a negative origin.
        assert_eq!(centered((-2560, 0), (2560, 1400), (840, 480)), (-2560 + 860, 460));
        // Bigger than the area: pinned to the corner, never off-screen.
        assert_eq!(centered((100, 50), (300, 200), (420, 240)), (100, 50));
    }

    #[test]
    fn unanswered_reply_is_ignored() {
        autofill_reply("nope".into(), json!({}));
    }

    fn good() -> Value {
        json!({"op":"save","host":"login.example.com","url":"https://login.example.com/signin",
               "username":"me@x.io","password":"hunter2","title":"Example"})
    }

    #[test]
    fn save_accepts_valid_and_strips_control_chars() {
        let mut v = good();
        v["title"] = json!("Ex\u{0007}ample\n");
        let r = validate_save(&v).unwrap();
        assert_eq!(r.title, "Example");
        assert_eq!(r.host, "login.example.com");
        let mut v = good();
        v["username"] = json!("");
        v["host"] = json!("localhost");
        v["url"] = json!("http://localhost:3000/login");
        assert!(validate_save(&v).is_ok());
        v["host"] = json!("127.0.0.1");
        v["url"] = json!("http://127.0.0.1/x");
        assert!(validate_save(&v).is_ok());
    }

    #[test]
    fn save_rejects_bad_input() {
        let bad = |k: &str, val: Value| {
            let mut v = good();
            v[k] = val;
            assert_eq!(validate_save(&v), Err("bad_request"), "{k}");
        };
        bad("host", json!(""));
        bad("host", json!("Example.com"));
        bad("host", json!("a.com:8080"));
        bad("host", json!("a".repeat(254)));
        bad("url", json!("http://example.com/"));
        bad("url", json!("javascript:alert(1)"));
        bad("url", json!(format!("https://a.com/{}", "x".repeat(2048))));
        bad("username", json!("u".repeat(257)));
        bad("password", json!(""));
        bad("password", json!("p".repeat(1025)));
        bad("title", json!("t".repeat(81)));
        bad("password", json!(5));
        assert!(validate_save(&json!({"op":"save"})).is_err());
    }
}

#[cfg(test)]
mod popup_tests {
    use super::*;

    #[test]
    fn list_needs_a_valid_host() {
        assert_eq!(validate_list(&json!({ "op": "list", "host": "example.com" })), Ok("example.com".into()));
        assert_eq!(validate_list(&json!({ "op": "list" })), Err("bad_request"));
        assert_eq!(validate_list(&json!({ "op": "list", "host": "" })), Err("bad_host"));
        assert_eq!(validate_list(&json!({ "op": "list", "host": "Example.com" })), Err("bad_host"));
        assert_eq!(validate_list(&json!({ "op": "list", "host": "a.com/x" })), Err("bad_host"));
    }

    #[test]
    fn copy_needs_host_account_and_a_known_field() {
        let ok = json!({ "op": "copy", "host": "example.com", "account": "Logins/Work.nqv", "what": "password" });
        assert_eq!(validate_copy(&ok), Ok(("example.com".into(), "Logins/Work.nqv".into(), "password")));
        for what in ["username", "password", "code"] {
            let mut v = ok.clone();
            v["what"] = json!(what);
            assert_eq!(validate_copy(&v).map(|r| r.2), Ok(what));
        }
        let bad = |k: &str, val: Value| {
            let mut v = ok.clone();
            v[k] = val;
            assert!(validate_copy(&v).is_err(), "{k}");
        };
        bad("what", json!("notes"));
        bad("what", json!(""));
        bad("what", Value::Null);
        bad("account", json!(""));
        bad("account", Value::Null);
        bad("account", json!("../outside.nqv"));
        bad("account", json!("C:/x.nqv"));
        bad("host", json!("EVIL"));
    }

    #[test]
    fn open_needs_host_and_account() {
        assert_eq!(
            validate_open(&json!({ "host": "example.com", "account": "a.nqv" })),
            Ok(("example.com".into(), "a.nqv".into()))
        );
        assert!(validate_open(&json!({ "host": "example.com" })).is_err());
        assert!(validate_open(&json!({ "account": "a.nqv" })).is_err());
    }

    #[test]
    fn list_reply_keeps_only_names() {
        let r = sanitize_list_reply(&json!({ "ok": true, "accounts": [
            { "account": "Logins/Work.nqv", "title": "Work\u{7}", "username": "alice", "totp": true, "password": "SECRET" },
            { "account": "../escape.nqv", "title": "x", "username": "y" },
            { "account": "Logins/Home.nqv", "title": 5, "username": "bob", "totp": "yes" },
        ] }));
        assert_eq!(r, json!({ "ok": true, "accounts": [
            { "account": "Logins/Work.nqv", "title": "Work", "username": "alice", "totp": true },
            { "account": "Logins/Home.nqv", "title": "", "username": "bob", "totp": false },
        ] }));
        assert!(!r.to_string().contains("SECRET"));
        let many: Vec<Value> = (0..80).map(|i| json!({ "account": format!("{i}.nqv"), "title": "t", "username": "u" })).collect();
        assert_eq!(sanitize_list_reply(&json!({ "ok": true, "accounts": many }))["accounts"].as_array().unwrap().len(), MAX_LIST);
        let long = sanitize_list_reply(&json!({ "ok": true, "accounts": [{ "account": "a.nqv", "title": "t".repeat(300), "username": "u" }] }));
        assert_eq!(long["accounts"][0]["title"].as_str().unwrap().chars().count(), 200);
    }

    #[test]
    fn list_reply_errors_are_short_words() {
        assert_eq!(sanitize_list_reply(&json!({ "error": "locked" })), json!({ "error": "locked" }));
        assert_eq!(sanitize_list_reply(&json!({ "error": "a b <c>" })), json!({ "error": "abc" }));
        assert_eq!(sanitize_list_reply(&json!({ "error": 5 })), json!({ "error": "failed" }));
        assert_eq!(sanitize_list_reply(&json!({ "accounts": [] })), json!({ "error": "failed" }));
        assert_eq!(sanitize_list_reply(&json!({ "ok": true })), json!({ "error": "failed" }));
        assert_eq!(sanitize_list_reply(&json!({ "ok": true, "accounts": [] })), json!({ "ok": true, "accounts": [] }));
    }

    #[test]
    fn copy_reply_never_carries_the_value() {
        let r = sanitize_copy_reply(&json!({ "ok": true, "clearAfter": 30, "password": "SECRET", "copied": "x" }), "password");
        assert_eq!(r, json!({ "ok": true, "copied": "password", "clearAfter": 30 }));
        assert_eq!(sanitize_copy_reply(&json!({ "ok": true }), "code"), json!({ "ok": true, "copied": "code", "clearAfter": 0 }));
        assert_eq!(sanitize_copy_reply(&json!({ "ok": true, "clearAfter": 99999 }), "code")["clearAfter"], json!(0));
        assert_eq!(sanitize_copy_reply(&json!({ "error": "denied" }), "password"), json!({ "error": "denied" }));
        assert_eq!(sanitize_copy_reply(&json!({ "ok": false }), "password"), json!({ "error": "failed" }));
    }

    #[test]
    fn popup_ops_never_start_the_app() {
        for op in ["list", "copy", "open"] {
            assert!(!may_launch(op), "{op}");
        }
    }
}
