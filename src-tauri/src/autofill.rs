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
//! * `{op:"ping"}` → `{ok:true}` (never starts the app)
//! * `{op:"launch"}` → `{ok:true}` once the app answers (starts it if needed) or `{error:"app_not_running"}`
//! * `{op:"fill", host, account?}` → `{ok:true, username, password, title, code?}` | `{choose:[{account,title,username}]}`
//!   | `{error}`. `account` is a vault entry's relative path from an earlier `choose`.
//! * `{op:"save", host, url, username, password, title}` → `{ok:true, status}` | `{error}`

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

/// Forwards a request to the UI and waits for its answer.
fn handle(app: &AppHandle, req: Value) -> Value {
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let (event, payload, host) = match op {
        "ping" => {
            touch_extension();
            return json!({ "ok": true });
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
        _ => return json!({ "error": "unknown_op" }),
    };
    let reply = await_ui(app, event, payload);
    record_request(&host, &reply);
    reply
}

/// The UI's autofill listeners are registered. Requests that arrive earlier wait briefly for it
/// (an app launched by the extension receives the request while its webview is still loading).
#[tauri::command]
pub fn autofill_ui_ready() {
    UI_READY.store(true, Ordering::Release);
}

fn wait_for_ui() {
    let start = Instant::now();
    while !UI_READY.load(Ordering::Acquire) && start.elapsed() < Duration::from_secs(20) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Registers a pending id, brings the window forward, emits `event` and waits for the UI's reply.
/// (A request answered silently by a trust window still briefly raises the window; the focus goes back
/// to the browser right after.)
fn await_ui(app: &AppHandle, event: &str, mut payload: Value) -> Value {
    let id = random_token();
    payload["id"] = json!(id);
    let (tx, rx) = channel();
    pending().lock().unwrap_or_else(|e| e.into_inner()).insert(id.clone(), tx);
    // The prompt has to be reachable, but once it is answered the browser should get the focus back.
    let win = app.get_webview_window("main");
    let was_minimized = win.as_ref().and_then(|w| w.is_minimized().ok()).unwrap_or(false);
    let browser = foreground_window();
    if let Some(w) = &win {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    wait_for_ui();
    let _ = app.emit(event, payload);
    let reply = rx.recv_timeout(ANSWER_TIMEOUT).unwrap_or_else(|_| json!({ "error": "timeout" }));
    pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if was_minimized {
        if let Some(w) = &win { let _ = w.minimize(); }
    }
    restore_foreground(browser);
    reply
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
    s.set_read_timeout(Some(ANSWER_TIMEOUT + Duration::from_secs(10))).ok()?;
    Some((s, r))
}

/// Ops that may start Notiq when it isn't running (a user action in the browser). `ping` never does.
fn may_launch(op: &str) -> bool {
    matches!(op, "fill" | "save" | "launch")
}

fn forward(conn: &mut Option<Conn>, req: &Value) -> Value {
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
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
        let ok = writeln!(w, "{req}").is_ok() && r.read_line(&mut line).map(|n| n > 0).unwrap_or(false);
        if ok {
            return serde_json::from_str(line.trim()).unwrap_or_else(|_| json!({ "error": "bad_reply" }));
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
    fn may_launch_only_for_user_actions() {
        assert!(may_launch("fill") && may_launch("save") && may_launch("launch"));
        assert!(!may_launch("ping") && !may_launch("hello") && !may_launch(""));
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
