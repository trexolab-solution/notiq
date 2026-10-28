//! Browser autofill bridge.
//!
//! ```text
//! browser extension ⇄ (native messaging, stdio) ⇄ `notiq --native-host`
//!                                                   ⇄ (127.0.0.1 TCP + token) ⇄ running Notiq app
//! ```
//!
//! The app never hands out a secret on its own: every request is forwarded to
//! the UI, which needs the vault to be unlocked and the user to press Allow.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::vault::atomic_write;

pub const HOST_NAME: &str = "com.trexolab.notiq";
/// Stable ID of the bundled Chrome/Edge extension (derived from the `key` in
/// `browser-extension/manifest.json`).
pub const EXTENSION_ID: &str = "cfddmbiaaboejbhnijkjodcganjdbcel";
const IPC_FILE: &str = "autofill_ipc.json";
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

/// Same folder Tauri uses for `app_data_dir()`, resolvable without a running app
/// (the native host is a bare process).
fn data_dir_plain() -> Option<PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join("com.trexolab.notiq"))
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
    #[cfg(windows)]
    register_native_host(&dir);

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

/// Forwards a request to the UI and waits for its answer.
fn handle(app: &AppHandle, req: Value) -> Value {
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let (event, payload) = match op {
        "ping" => return json!({ "ok": true }),
        "fill" => {
            let host = req.get("host").and_then(|v| v.as_str()).unwrap_or("");
            if host.is_empty() || host.len() > 253 {
                return json!({ "error": "bad_host" });
            }
            ("autofill:request", json!({ "host": host }))
        }
        "save" => match validate_save(&req) {
            Ok(s) => (
                "autofill:save",
                json!({ "host": s.host, "url": s.url, "username": s.username, "password": s.password, "title": s.title }),
            ),
            Err(e) => return json!({ "error": e }),
        },
        _ => return json!({ "error": "unknown_op" }),
    };
    await_ui(app, event, payload)
}

/// Registers a pending id, brings the window forward, emits `event` and waits for the UI's reply.
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

/// The UI answers a request (allowed credentials, or an error such as `denied`).
#[tauri::command]
pub fn autofill_reply(id: String, payload: Value) {
    if let Some(tx) = pending().lock().unwrap_or_else(|e| e.into_inner()).remove(&id) {
        let _ = tx.send(payload);
    }
}

/// Writes the native-messaging manifest and points Chrome / Edge / Brave at it.
#[cfg(windows)]
fn register_native_host(dir: &std::path::Path) {
    use winreg::enums::*;
    use winreg::RegKey;
    let Ok(exe) = std::env::current_exe() else { return };
    let manifest = json!({
        "name": HOST_NAME,
        "description": "Notiq autofill bridge",
        "path": exe.to_string_lossy(),
        "type": "stdio",
        "allowed_origins": [format!("chrome-extension://{EXTENSION_ID}/")],
    });
    let mpath = dir.join(format!("{HOST_NAME}.json"));
    if atomic_write(&mpath, manifest.to_string().as_bytes()).is_err() {
        return;
    }
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for base in [
        "Software\\Google\\Chrome\\NativeMessagingHosts",
        "Software\\Microsoft\\Edge\\NativeMessagingHosts",
        "Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
    ] {
        if let Ok((k, _)) = hkcu.create_subkey(format!("{base}\\{HOST_NAME}")) {
            let _ = k.set_value("", &mpath.to_string_lossy().as_ref());
        }
    }
}

// ─── Native host (bare process started by the browser) ───────────────────────

/// True when the browser launched us for native messaging.
pub fn is_native_host_launch() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("chrome-extension://") || a == "--native-host")
}

/// Bridges the browser's framed stdio to the app. Never returns normally.
pub fn run_native_host() {
    // Only our own extension may talk to us.
    let origin_ok = std::env::args()
        .skip(1)
        .any(|a| a == format!("chrome-extension://{EXTENSION_ID}/"));
    if !origin_ok {
        return;
    }
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut conn: Option<(TcpStream, BufReader<TcpStream>)> = None;

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

fn connect() -> Option<(TcpStream, BufReader<TcpStream>)> {
    let raw = std::fs::read_to_string(data_dir_plain()?.join(IPC_FILE)).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port")?.as_u64()? as u16;
    let token = v.get("token")?.as_str()?.to_string();
    let mut s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(ANSWER_TIMEOUT + Duration::from_secs(10))).ok()?;
    writeln!(s, "{}", json!({ "token": token })).ok()?;
    let r = BufReader::new(s.try_clone().ok()?);
    Some((s, r))
}

fn forward(conn: &mut Option<(TcpStream, BufReader<TcpStream>)>, req: &Value) -> Value {
    for attempt in 0..2 {
        if conn.is_none() {
            *conn = connect();
        }
        let Some((w, r)) = conn.as_mut() else {
            return json!({ "error": "app_not_running" });
        };
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
