//! 0.13.0 "Share files to phone": a read-only WebDAV server for one folder of this computer, reachable on the local
//! network only. A phone's WebDAV client (Solid Explorer, Documents, Files, FolderSync, …) can browse and download.
//!
//! Safety, in order of importance:
//!  * it listens on the computer's LAN address only (never on every interface, never on the internet);
//!  * every request needs the user name and password (HTTP Basic): the ones the user typed, or `notiq` + a random password;
//!  * only OPTIONS / GET / HEAD / PROPFIND are answered, so nothing can be written, moved or deleted;
//!  * symbolic links are hidden, so a link inside the folder can't lead out of it;
//!  * sharing lasts until it is stopped or the app closes. Nothing is stored on disk.
//!
//! The connection is plain HTTP (no certificate), so use it on a network you trust.

use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use dav_server::body::Body;
use dav_server::fakels::FakeLs;
use dav_server::localfs::LocalFs;
use dav_server::DavHandler;
use hyper::body::Incoming;
use hyper::header::{ALLOW, AUTHORIZATION, WWW_AUTHENTICATE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rand::Rng;
use serde::Serialize;
use tauri::State;
use tokio::net::TcpListener;
use tokio::sync::watch;

const DEFAULT_USERNAME: &str = "notiq";
const MIN_PASSWORD: usize = 8;
/// Tried first so a phone's saved connection keeps working; any free port is used when it is taken.
const PREFERRED_PORT: u16 = 8765;
/// The only requests answered: reading and listing. PROPFIND is how a client lists a folder.
const ALLOWED: &str = "OPTIONS, GET, HEAD, PROPFIND";

/// What the settings page shows while a folder is shared.
#[derive(Clone, Serialize)]
pub struct ShareInfo {
    url: String,
    username: String,
    password: String,
    folder: String,
}

struct Running {
    info: ShareInfo,
    stop: watch::Sender<bool>,
}

#[derive(Default)]
pub struct WebdavState(Mutex<Option<Running>>);

/// 16 letters and digits (about 95 bits): easy to type on a phone, hopeless to guess.
fn make_password() -> String {
    const CHARS: &[u8] = b"abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..16).map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char).collect()
}

/// This computer's address on the local network: the one the system would use to reach another machine.
/// (Connecting a UDP socket sends nothing; it only makes the system pick the outgoing interface.)
fn lan_ip() -> Option<IpAddr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("192.0.2.1:9").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified() && !ip.is_loopback()).then_some(ip)
}

/// Compares without stopping at the first difference, so the time taken doesn't reveal how much matched.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}

/// Checks what the user typed (empty = the default) and returns the user name and password to use.
fn credentials(username: Option<String>, password: Option<String>) -> Result<(String, String), String> {
    let user = username.map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| DEFAULT_USERNAME.into());
    if user.chars().count() > 32 || user.contains(':') || user.chars().any(char::is_control) {
        return Err("The user name can have up to 32 characters and no colon (:).".into());
    }
    let pass = match password.filter(|p| !p.is_empty()) {
        None => make_password(),
        Some(p) if p.chars().count() < MIN_PASSWORD => return Err(format!("Use a password of at least {MIN_PASSWORD} characters.")),
        Some(p) if p.chars().count() > 64 || p.chars().any(char::is_control) => return Err("The password can have up to 64 characters.".into()),
        Some(p) => p,
    };
    Ok((user, pass))
}

/// Whether an `Authorization` header carries the right user name and password (`login` is "user:password").
fn authorized(header: Option<&str>, login: &str) -> bool {
    let Some(rest) = header.and_then(|h| h.strip_prefix("Basic ")) else { return false };
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(rest.trim()) else { return false };
    same(&raw, login.as_bytes())
}

fn reply(status: StatusCode, extra: &[(&str, &str)], text: &str) -> Response<Body> {
    let mut r = Response::builder().status(status);
    for (k, v) in extra { r = r.header(*k, *v); }
    r.body(Body::from(text)).unwrap_or_else(|_| Response::new(Body::from("")))
}

/// The file-manager page a browser gets for a folder (it lists the folder itself with PROPFIND).
const PAGE: &str = include_str!("webdav_ui.html");
/// What that page may do: run its own script and styles, load files from this server only, nothing else.
const PAGE_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'";

/// A browser opening a folder (an address ending in "/" that accepts HTML) gets the page; other clients get WebDAV.
fn wants_page(req: &Request<Incoming>) -> bool {
    req.method() == Method::GET
        && req.uri().path().ends_with('/')
        && req.headers().get(hyper::header::ACCEPT).and_then(|v| v.to_str().ok()).is_some_and(|a| a.contains("text/html"))
}

fn page() -> Response<Body> {
    reply(StatusCode::OK, &[
        ("Content-Type", "text/html; charset=utf-8"), ("Content-Security-Policy", PAGE_CSP), ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
    ], PAGE)
}

/// Headers for the shared files themselves: no content sniffing, and a page-like file (HTML, SVG) opened on its own
/// runs in a sandbox, so a file inside the share can't act with the signed-in session. Images, video and PDFs are unaffected.
fn harden(mut res: Response<Body>) -> Response<Body> {
    use hyper::header::{HeaderName, HeaderValue, CONTENT_TYPE};
    let h = res.headers_mut();
    h.insert(HeaderName::from_static("x-content-type-options"), HeaderValue::from_static("nosniff"));
    let pagelike = h.get(CONTENT_TYPE).and_then(|v| v.to_str().ok()).is_some_and(|t| {
        let t = t.to_ascii_lowercase();
        t.starts_with("text/html") || t.starts_with("image/svg") || t.contains("xhtml") || t.contains("xml") && !t.contains("dav")
    });
    if pagelike { h.insert(HeaderName::from_static("content-security-policy"), HeaderValue::from_static("sandbox")); }
    res
}

/// One request: password check, then only the reading methods go on to the WebDAV handler.
async fn serve(req: Request<Incoming>, dav: DavHandler, login: std::sync::Arc<String>) -> Result<Response<Body>, Infallible> {
    let header = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok());
    if !authorized(header, &login) {
        // A short pause makes guessing passwords slow.
        tokio::time::sleep(Duration::from_millis(400)).await;
        return Ok(reply(StatusCode::UNAUTHORIZED, &[(WWW_AUTHENTICATE.as_str(), "Basic realm=\"Notiq\", charset=\"UTF-8\"")], "Sign in"));
    }
    match *req.method() {
        Method::OPTIONS => Ok(reply(StatusCode::OK, &[("DAV", "1"), (ALLOW.as_str(), ALLOWED), ("MS-Author-Via", "DAV")], "")),
        Method::GET if wants_page(&req) => Ok(page()),
        Method::GET | Method::HEAD => Ok(harden(dav.handle(req).await)),
        ref m if m.as_str() == "PROPFIND" => Ok(dav.handle(req).await),
        _ => Ok(reply(StatusCode::METHOD_NOT_ALLOWED, &[(ALLOW.as_str(), ALLOWED)], "This share is read-only")),
    }
}

/// Answers requests on `listener` until `stopped` changes.
async fn run(listener: TcpListener, dir: std::path::PathBuf, login: String, mut stopped: watch::Receiver<bool>) {
    let dav = DavHandler::builder()
        .filesystem(LocalFs::new(&dir, false, false, false))
        .locksystem(FakeLs::new())
        .hide_symlinks(true)
        .autoindex(true) // a browser opening the address gets a page listing the folder
        .build_handler();
    let login = std::sync::Arc::new(login);
    loop {
        tokio::select! {
            _ = stopped.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let (dav, login, mut stopped) = (dav.clone(), login.clone(), stopped.clone());
                tokio::spawn(async move {
                    let conn = http1::Builder::new().serve_connection(
                        TokioIo::new(stream),
                        service_fn(move |req| serve(req, dav.clone(), login.clone())),
                    );
                    tokio::select! { _ = conn => {}, _ = stopped.changed() => {} }
                });
            }
        }
    }
}

#[tauri::command]
pub async fn webdav_start(folder: String, username: Option<String>, password: Option<String>, state: State<'_, WebdavState>) -> Result<ShareInfo, String> {
    if state.0.lock().unwrap_or_else(|e| e.into_inner()).is_some() { return Err("Sharing is already on.".into()); }
    let dir = std::fs::canonicalize(Path::new(&folder)).map_err(|_| "That folder doesn't exist.".to_string())?;
    if !dir.is_dir() { return Err("Pick a folder to share.".into()); }
    let ip = lan_ip().ok_or("Couldn't find this computer on a network. Connect to Wi-Fi or a cable and try again.")?;

    let listener = match TcpListener::bind(SocketAddr::new(ip, PREFERRED_PORT)).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(SocketAddr::new(ip, 0)).await.map_err(|e| format!("Couldn't start sharing: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (username, password) = credentials(username, password)?;
    let info = ShareInfo {
        url: format!("http://{ip}:{port}/"),
        username: username.clone(),
        password: password.clone(),
        folder: dir.to_string_lossy().trim_start_matches(r"\\?\").to_string(),
    };

    let (stop, stopped) = watch::channel(false);
    tokio::spawn(run(listener, dir, format!("{username}:{password}"), stopped));

    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Running { info: info.clone(), stop });
    Ok(info)
}

#[tauri::command]
pub fn webdav_stop(state: State<'_, WebdavState>) {
    if let Some(r) = state.0.lock().unwrap_or_else(|e| e.into_inner()).take() { let _ = r.stop.send(true); }
}

/// The running share, if any (the settings page asks when it opens).
#[tauri::command]
pub fn webdav_status(state: State<'_, WebdavState>) -> Option<ShareInfo> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|r| r.info.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basic(user_pass: &str) -> String { format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(user_pass)) }

    #[test]
    fn password_is_16_unambiguous_characters_and_differs() {
        let (a, b) = (make_password(), make_password());
        assert_eq!(a.len(), 16);
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric() && !"0OIl1".contains(c)));
        assert_ne!(a, b);
    }

    #[test]
    fn custom_login_is_checked() {
        assert_eq!(credentials(Some(" Pintu ".into()), Some("hunter2hunter2".into())).unwrap(), ("Pintu".into(), "hunter2hunter2".into()));
        let (u, p) = credentials(None, Some(String::new())).unwrap();
        assert_eq!((u.as_str(), p.len()), ("notiq", 16));
        assert!(credentials(Some("a:b".into()), None).is_err());
        assert!(credentials(Some("x".repeat(33)), None).is_err());
        assert!(credentials(None, Some("short".into())).is_err());
        assert!(credentials(None, Some("tab	here-long".into())).is_err());
    }

    #[test]
    fn only_the_right_user_and_password_pass() {
        assert!(authorized(Some(&basic("notiq:secret")), "notiq:secret"));
        assert!(!authorized(Some(&basic("notiq:wrong")), "notiq:secret"));
        assert!(!authorized(Some(&basic("admin:secret")), "notiq:secret"));
        assert!(!authorized(Some("Bearer secret"), "notiq:secret"));
        assert!(!authorized(Some("Basic !!!"), "notiq:secret"));
        assert!(!authorized(None, "notiq:secret"));
    }

    #[tokio::test]
    async fn serves_reading_only_and_only_with_the_password() {
        let dir = std::env::temp_dir().join(format!("notiq-dav-{}", make_password()));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(run(listener, dir.clone(), "notiq:pw".into(), stopped));

        let c = reqwest::Client::new();
        let m = |s: &str| Method::from_bytes(s.as_bytes()).unwrap();
        let go = |method: &str, path: &str, auth: bool| {
            let r = c.request(m(method), format!("{base}{path}"));
            let r = if method == "GET" || method == "PROPFIND" { r } else { r.body("x") };
            if auth { r.basic_auth("notiq", Some("pw")) } else { r }.send()
        };
        assert_eq!(go("GET", "/a.txt", false).await.unwrap().status(), 401);
        assert_eq!(c.get(format!("{base}/a.txt")).basic_auth("notiq", Some("nope")).send().await.unwrap().status(), 401);
        let got = go("GET", "/a.txt", true).await.unwrap();
        assert_eq!(got.status(), 200);
        assert_eq!(got.text().await.unwrap(), "hello");
        // A browser (Accept: text/html) gets the file-manager page, with its own security headers.
        let browser = c.get(format!("{base}/")).basic_auth("notiq", Some("pw")).header("Accept", "text/html,application/xhtml+xml").send().await.unwrap();
        assert_eq!(browser.status(), 200);
        assert!(browser.headers()["content-security-policy"].to_str().unwrap().contains("default-src 'none'"));
        assert!(browser.text().await.unwrap().contains("Search this folder"));
        // Another client (no HTML in Accept) still gets the plain folder listing.
        let page = go("GET", "/", true).await.unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.text().await.unwrap().contains("a.txt"));
        // A page-like file is sandboxed, and nothing is sniffed.
        std::fs::write(dir.join("x.html"), "<script>1</script>").unwrap();
        let h = go("GET", "/x.html", true).await.unwrap();
        assert_eq!(h.headers()["content-security-policy"], "sandbox");
        assert_eq!(h.headers()["x-content-type-options"], "nosniff");
        // A range request (video seeking) still works.
        let part = c.get(format!("{base}/a.txt")).basic_auth("notiq", Some("pw")).header("Range", "bytes=1-3").send().await.unwrap();
        assert_eq!(part.status(), 206);
        assert_eq!(part.text().await.unwrap(), "ell");
        let list = go("PROPFIND", "/", true).await.unwrap();
        assert_eq!(list.status(), 207);
        assert!(list.text().await.unwrap().contains("a.txt"));
        for bad in ["PUT", "DELETE", "MKCOL", "MOVE", "COPY", "PROPPATCH", "LOCK", "POST"] {
            assert_eq!(go(bad, "/a.txt", true).await.unwrap().status(), 405, "{bad}");
        }
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "hello");
        assert!(!dir.join("sub").join("x").exists());
        stop.send(true).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
