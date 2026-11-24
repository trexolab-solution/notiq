//! 0.13.0 WebDAV sharing ("Share files to phone"): a WebDAV server (read-only unless uploads / file management are turned on) for one folder of this computer, reachable on the local
//! network only. A phone's WebDAV client (Solid Explorer, Documents, Files, FolderSync, …) can browse and download.
//!
//! Safety, in order of importance:
//!  * with "Use HTTPS" it speaks TLS with a self-signed certificate made by Notiq (see webdav_tls.rs), so nothing
//!    crosses the network in the clear; the page shows the certificate fingerprint to compare on the phone;
//!  * it listens on the computer's LAN address only (never on every interface, never on the internet);
//!  * every request needs the user name and password (HTTP Basic): the ones the user typed, or `notiq` + a random password;
//!  * only OPTIONS / GET / HEAD / PROPFIND are answered, so nothing can be written, moved or deleted. When the user
//!    turns uploads on, PUT and MKCOL are answered too, but only for a NEW file or folder inside the shared folder:
//!    nothing is overwritten, deleted or moved. A second switch, "manage", also answers MOVE (rename / move), COPY and
//!    DELETE, still never replacing an existing file, never touching the shared folder itself and never following links;
//!  * symbolic links are hidden, so a link inside the folder can't lead out of it;
//!  * sharing lasts until it is stopped or the app closes. Nothing is stored on disk.
//!
//! Without HTTPS the connection is plain HTTP, so use it on a network you trust.

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
use tokio_rustls::TlsAcceptor;

const DEFAULT_USERNAME: &str = "notiq";
const MIN_PASSWORD: usize = 8;
/// Tried first so a phone's saved connection keeps working; any free port is used when it is taken.
const PREFERRED_PORT: u16 = 8765;
/// The same for HTTPS, so the two never fight over one port.
const PREFERRED_TLS_PORT: u16 = 8766;
/// The only requests answered: reading and listing. PROPFIND is how a client lists a folder.
const ALLOWED: &str = "OPTIONS, GET, HEAD, PROPFIND";
/// The same, with uploads on.
const ALLOWED_UPLOAD: &str = "OPTIONS, GET, HEAD, PROPFIND, PUT, MKCOL";
/// The same, with file management on.
const ALLOWED_MANAGE: &str = "OPTIONS, GET, HEAD, PROPFIND, PUT, MKCOL, MOVE, COPY, DELETE";

/// What the settings page shows while a folder is shared.
#[derive(Clone, Serialize)]
pub struct ShareInfo {
    url: String,
    username: String,
    password: String,
    folder: String,
    /// Whether a phone may add new files and folders.
    upload: bool,
    /// Whether a phone may also rename, move, copy and delete.
    manage: bool,
    /// The connection is encrypted (the address starts with https).
    https: bool,
    /// SHA-256 of the certificate (`AB:CD:…`) when `https`: what a phone's certificate details should show.
    fingerprint: Option<String>,
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

/// The page with the app icon filled in as its favicon (a data URI, so it needs no extra request), built once.
fn page_html() -> &'static str {
    static HTML: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HTML.get_or_init(|| {
        let uri = |bytes: &[u8]| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes));
        PAGE.replace("__FAVICON__", &uri(include_bytes!("../icons/32x32.png"))).replace("__TOUCH_ICON__", &uri(include_bytes!("../icons/128x128.png")))
    })
}

fn page() -> Response<Body> {
    reply(StatusCode::OK, &[
        ("Content-Type", "text/html; charset=utf-8"), ("Content-Security-Policy", PAGE_CSP), ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"), ("Referrer-Policy", "no-referrer"),
    ], page_html())
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

/// What a request is checked against.
struct Guard {
    /// "user:password".
    login: String,
    upload: bool,
    manage: bool,
    /// The shared folder, canonical.
    root: std::path::PathBuf,
}

fn allowed(g: &Guard) -> &'static str { if g.manage { ALLOWED_MANAGE } else if g.upload { ALLOWED_UPLOAD } else { ALLOWED } }

/// Names Windows refuses (or treats as a device) in any folder.
fn windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit())
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else { out.push(b[i]); i += 1; }
    }
    String::from_utf8(out).ok()
}

/// The names in a request path, if each is acceptable: no `..` or `.`, no empty name, no drive letter / stream (`:`), no
/// backslash or other characters Windows refuses, no device names, no trailing dot or space.
fn clean_parts(uri_path: &str) -> Result<Vec<String>, &'static str> {
    let decoded = percent_decode(uri_path).ok_or("That name isn't valid.")?;
    let parts: Vec<String> = decoded.trim_end_matches('/').split('/').skip(1).map(str::to_string).collect();
    if parts.is_empty() { return Err("That name isn't valid."); }
    for p in &parts {
        let bad = p.is_empty() || p == "." || p == ".." || p.contains(['\\', ':', '<', '>', '"', '|', '?', '*']) || p.chars().any(char::is_control)
            || p.ends_with('.') || p.ends_with(' ') || windows_reserved(p);
        if bad { return Err("That name isn't valid."); }
    }
    Ok(parts)
}

/// The path of `parts` under `root`, with its parent folder checked to be a real folder inside the share.
fn under_root(root: &Path, parts: &[String]) -> Result<std::path::PathBuf, &'static str> {
    let target = parts.iter().fold(root.to_path_buf(), |acc, p| acc.join(p));
    let parent = target.parent().ok_or("That name isn't valid.")?;
    let parent = std::fs::canonicalize(parent).map_err(|_| "The folder doesn't exist.")?;
    if !parent.starts_with(root) || !parent.is_dir() { return Err("That name isn't valid."); }
    Ok(target)
}

/// Where a new file or folder named by a request path would go, if that is allowed: a name that does not exist yet,
/// directly inside a real folder of the share (see `clean_parts` for the refused names; also a missing parent, a link
/// leading out of the shared folder, and anything that already exists).
fn new_target(root: &Path, uri_path: &str) -> Result<std::path::PathBuf, &'static str> {
    let target = under_root(root, &clean_parts(uri_path)?)?;
    if std::fs::symlink_metadata(&target).is_ok() { return Err("A file or folder with that name already exists."); }
    Ok(target)
}

/// An existing file or folder inside the share that may be renamed, moved, copied or deleted: never the shared folder
/// itself, and never a link.
fn existing_target(root: &Path, uri_path: &str) -> Result<std::path::PathBuf, &'static str> {
    let target = under_root(root, &clean_parts(uri_path)?)?;
    let meta = std::fs::symlink_metadata(&target).map_err(|_| "That file or folder doesn't exist.")?;
    if meta.file_type().is_symlink() { return Err("That name isn't valid."); }
    Ok(target)
}

/// The path part of a MOVE / COPY `Destination` header (it may be a full address or just a path).
fn destination_path(req: &Request<Incoming>) -> Option<String> {
    let v = req.headers().get("destination")?.to_str().ok()?;
    let uri: hyper::Uri = v.parse().ok()?;
    Some(uri.path().to_string())
}

/// One request: password check, then only the reading methods (and, if turned on, adding new things) go on to the WebDAV handler.
async fn serve(mut req: Request<Incoming>, dav: DavHandler, guard: std::sync::Arc<Guard>) -> Result<Response<Body>, Infallible> {
    let header = req.headers().get(AUTHORIZATION).and_then(|v| v.to_str().ok());
    if !authorized(header, &guard.login) {
        // A short pause makes guessing passwords slow.
        tokio::time::sleep(Duration::from_millis(400)).await;
        return Ok(reply(StatusCode::UNAUTHORIZED, &[(WWW_AUTHENTICATE.as_str(), "Basic realm=\"Notiq\", charset=\"UTF-8\"")], "Sign in"));
    }
    match *req.method() {
        Method::OPTIONS => Ok(reply(StatusCode::OK, &[("DAV", "1"), (ALLOW.as_str(), allowed(&guard)), ("MS-Author-Via", "DAV")], "")),
        Method::GET if wants_page(&req) => Ok(page()),
        Method::GET | Method::HEAD => Ok(harden(dav.handle(req).await)),
        ref m if m.as_str() == "PROPFIND" => Ok(dav.handle(req).await),
        ref m if guard.manage && m.as_str() == "DELETE" => match existing_target(&guard.root, req.uri().path()) {
            Ok(_) => Ok(dav.handle(req).await),
            Err(why) => Ok(reply(StatusCode::CONFLICT, &[], why)),
        },
        ref m if guard.manage && (m.as_str() == "MOVE" || m.as_str() == "COPY") => {
            // Both ends must be acceptable, and nothing that exists may be replaced.
            let from = existing_target(&guard.root, req.uri().path()).map(|_| ());
            let to = match destination_path(&req) { Some(d) => new_target(&guard.root, &d).map(|_| ()), None => Err("Missing destination.") };
            match from.and(to) {
                Ok(()) => {
                    req.headers_mut().insert("overwrite", hyper::header::HeaderValue::from_static("F"));
                    Ok(dav.handle(req).await)
                }
                Err(why) => Ok(reply(StatusCode::CONFLICT, &[], why)),
            }
        }
        ref m if guard.upload && (m == Method::PUT || m.as_str() == "MKCOL") => match new_target(&guard.root, req.uri().path()) {
            Ok(_) => Ok(dav.handle(req).await),
            Err(why) => Ok(reply(StatusCode::CONFLICT, &[], why)),
        },
        _ => Ok(reply(StatusCode::METHOD_NOT_ALLOWED, &[(ALLOW.as_str(), allowed(&guard))], if guard.manage { "That request isn't allowed" } else if guard.upload { "Only new files and folders can be added" } else { "This share is read-only" })),
    }
}

/// Answers requests on `listener` until `stopped` changes.
/// Serves HTTP on one accepted connection (plain or already inside TLS) until it ends or sharing stops.
async fn serve_io<I>(io: I, dav: DavHandler, guard: std::sync::Arc<Guard>, mut stopped: watch::Receiver<bool>)
where I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static {
    let conn = http1::Builder::new().serve_connection(TokioIo::new(io), service_fn(move |req| serve(req, dav.clone(), guard.clone())));
    tokio::select! { _ = conn => {}, _ = stopped.changed() => {} }
}

async fn run(listener: TcpListener, dir: std::path::PathBuf, login: String, upload: bool, manage: bool, tls: Option<TlsAcceptor>, mut stopped: watch::Receiver<bool>) {
    let dav = DavHandler::builder()
        .filesystem(LocalFs::new(&dir, false, false, false))
        .locksystem(FakeLs::new())
        .hide_symlinks(true)
        .autoindex(true) // a browser opening the address gets a page listing the folder
        .build_handler();
    let guard = std::sync::Arc::new(Guard { login, upload: upload || manage, manage, root: dir.clone() });
    loop {
        tokio::select! {
            _ = stopped.changed() => break,
            accepted = listener.accept() => {
                let Ok((stream, _)) = accepted else { continue };
                let (dav, guard, stopped, tls) = (dav.clone(), guard.clone(), stopped.clone(), tls.clone());
                tokio::spawn(async move {
                    match tls {
                        // A client that never finishes the handshake (or speaks plain HTTP to this port) is dropped.
                        Some(acceptor) => match tokio::time::timeout(Duration::from_secs(10), acceptor.accept(stream)).await {
                            Ok(Ok(secure)) => serve_io(secure, dav, guard, stopped).await,
                            _ => {}
                        },
                        None => serve_io(stream, dav, guard, stopped).await,
                    }
                });
            }
        }
    }
}

#[tauri::command]
pub async fn webdav_start(folder: String, username: Option<String>, password: Option<String>, upload: Option<bool>, manage: Option<bool>, https: Option<bool>,
                           app: tauri::AppHandle, state: State<'_, WebdavState>) -> Result<ShareInfo, String> {
    if state.0.lock().unwrap_or_else(|e| e.into_inner()).is_some() { return Err("Sharing is already on.".into()); }
    let dir = std::fs::canonicalize(Path::new(&folder)).map_err(|_| "That folder doesn't exist.".to_string())?;
    if !dir.is_dir() { return Err("Pick a folder to share.".into()); }
    let ip = lan_ip().ok_or("Couldn't find this computer on a network. Connect to Wi-Fi or a cable and try again.")?;

    let https = https.unwrap_or(false);
    // The certificate comes first: if it can't be made, nothing has been started yet.
    let tls = if https {
        use tauri::Manager as _;
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("webdav-tls");
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
        let (config, fp) = crate::webdav_tls::load_or_make(&dir, ip, now)?;
        Some((TlsAcceptor::from(config), fp))
    } else { None };

    let listener = match TcpListener::bind(SocketAddr::new(ip, if https { PREFERRED_TLS_PORT } else { PREFERRED_PORT })).await {
        Ok(l) => l,
        Err(_) => TcpListener::bind(SocketAddr::new(ip, 0)).await.map_err(|e| format!("Couldn't start sharing: {e}"))?,
    };
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let (username, password) = credentials(username, password)?;
    let info = ShareInfo {
        url: format!("{}://{ip}:{port}/", if https { "https" } else { "http" }),
        username: username.clone(),
        password: password.clone(),
        folder: dir.to_string_lossy().trim_start_matches(r"\\?\").to_string(),
        upload: upload.unwrap_or(false) || manage.unwrap_or(false),
        manage: manage.unwrap_or(false),
        https,
        fingerprint: tls.as_ref().map(|(_, fp)| fp.clone()),
    };

    let (stop, stopped) = watch::channel(false);
    tokio::spawn(run(listener, dir, format!("{username}:{password}"), info.upload, info.manage, tls.map(|(a, _)| a), stopped));

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
    fn new_target_allows_only_new_names_inside_the_share() {
        let root = std::fs::canonicalize(std::env::temp_dir()).unwrap().join(format!("notiq-up-{}", make_password()));
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("old.txt"), "x").unwrap();
        assert!(new_target(&root, "/new.txt").is_ok());
        assert!(new_target(&root, "/sub/new%20file.txt").is_ok());
        for bad in ["/old.txt", "/", "/../evil.txt", "/sub/../../evil.txt", "/%2e%2e/evil.txt", "/a\\b.txt", "/c:evil.txt", "/x:stream", "/nul", "/COM1.txt", "/dir./f", "/missing/new.txt", "/sub//x", "/bad%zz"] {
            assert!(new_target(&root, bad).is_err(), "{bad}");
        }
        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn uploads_add_new_files_and_folders_only_when_turned_on() {
        let dir = std::env::temp_dir().join(format!("notiq-dav-up-{}", make_password()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("keep.txt"), "original").unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(run(listener, dir.clone(), "notiq:pw".into(), true, false, None, stopped));

        let c = reqwest::Client::new();
        let call = |m: &str, path: &str, body: Option<&'static str>| {
            let r = c.request(Method::from_bytes(m.as_bytes()).unwrap(), format!("{base}{path}")).basic_auth("notiq", Some("pw"));
            if let Some(b) = body { r.body(b) } else { r }.send()
        };
        assert_eq!(call("PUT", "/photo.jpg", Some("bytes")).await.unwrap().status(), 201);
        assert_eq!(std::fs::read_to_string(dir.join("photo.jpg")).unwrap(), "bytes");
        assert_eq!(call("MKCOL", "/Trip/", None).await.unwrap().status(), 201);
        assert_eq!(call("PUT", "/Trip/a.txt", Some("in folder")).await.unwrap().status(), 201);
        // Nothing existing is replaced, and nothing is deleted or moved.
        assert_eq!(call("PUT", "/keep.txt", Some("overwritten")).await.unwrap().status(), 409);
        assert_eq!(std::fs::read_to_string(dir.join("keep.txt")).unwrap(), "original");
        for bad in ["DELETE", "MOVE", "COPY", "PROPPATCH", "LOCK"] {
            assert_eq!(call(bad, "/keep.txt", None).await.unwrap().status(), 405, "{bad}");
        }
        // The page learns about uploads from OPTIONS.
        let o = call("OPTIONS", "/", None).await.unwrap();
        assert!(o.headers()["allow"].to_str().unwrap().contains("PUT"));
        stop.send(true).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn managing_renames_moves_copies_and_deletes_without_replacing_anything() {
        let dir = std::env::temp_dir().join(format!("notiq-dav-mg-{}", make_password()));
        std::fs::create_dir_all(dir.join("Sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "A").unwrap();
        std::fs::write(dir.join("b.txt"), "B").unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let base = format!("http://{addr}");
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(run(listener, dir.clone(), "notiq:pw".into(), false, true, None, stopped));

        let c = reqwest::Client::new();
        let call = |m: &str, path: &str, dest: Option<&str>| {
            let r = c.request(Method::from_bytes(m.as_bytes()).unwrap(), format!("{base}{path}")).basic_auth("notiq", Some("pw"));
            if let Some(d) = dest { r.header("Destination", format!("{base}{d}")) } else { r }.send()
        };
        // Rename, move into a folder, copy.
        assert!(call("MOVE", "/a.txt", Some("/renamed.txt")).await.unwrap().status().is_success());
        assert!(!dir.join("a.txt").exists() && dir.join("renamed.txt").exists());
        assert!(call("MOVE", "/renamed.txt", Some("/Sub/renamed.txt")).await.unwrap().status().is_success());
        assert!(call("COPY", "/b.txt", Some("/Sub/b-copy.txt")).await.unwrap().status().is_success());
        assert!(dir.join("b.txt").exists() && dir.join("Sub").join("b-copy.txt").exists());
        // Nothing that exists is replaced, nothing leaves the share, and the share itself can't be touched.
        assert_eq!(call("MOVE", "/b.txt", Some("/Sub/renamed.txt")).await.unwrap().status(), 409);
        assert_eq!(call("COPY", "/b.txt", Some("/Sub/renamed.txt")).await.unwrap().status(), 409);
        assert_eq!(call("MOVE", "/b.txt", Some("/%2e%2e/out.txt")).await.unwrap().status(), 409);
        assert_eq!(call("DELETE", "/", None).await.unwrap().status(), 409);
        assert_eq!(call("DELETE", "/nope.txt", None).await.unwrap().status(), 409);
        assert_eq!(std::fs::read_to_string(dir.join("Sub").join("renamed.txt")).unwrap(), "A");
        // Delete a file and a folder (with what is inside).
        assert!(call("DELETE", "/b.txt", None).await.unwrap().status().is_success());
        assert!(call("DELETE", "/Sub/", None).await.unwrap().status().is_success());
        assert!(!dir.join("b.txt").exists() && !dir.join("Sub").exists());
        let o = call("OPTIONS", "/", None).await.unwrap();
        assert!(o.headers()["allow"].to_str().unwrap().contains("DELETE"));
        stop.send(true).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn uploads_alone_do_not_allow_rename_move_or_delete() {
        let dir = std::env::temp_dir().join(format!("notiq-dav-ro-{}", make_password()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "A").unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(run(listener, dir.clone(), "notiq:pw".into(), true, false, None, stopped));
        let c = reqwest::Client::new();
        for m in ["DELETE", "MOVE", "COPY"] {
            let res = c.request(Method::from_bytes(m.as_bytes()).unwrap(), format!("{base}/a.txt")).basic_auth("notiq", Some("pw")).header("Destination", format!("{base}/z.txt")).send().await.unwrap();
            assert_eq!(res.status(), 405, "{m}");
        }
        assert!(dir.join("a.txt").exists());
        stop.send(true).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn https_serves_the_same_things_but_only_over_tls() {
        let dir = std::env::temp_dir().join(format!("notiq-dav-tls-{}", make_password()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "secret").unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        let (cert, key) = crate::webdav_tls::make_cert("127.0.0.1".parse().unwrap(), 1_700_000_000 + 400 * 86_400).unwrap();
        let (config, fp) = crate::webdav_tls::server_config(&cert, &key).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, stopped) = watch::channel(false);
        tokio::spawn(run(listener, dir.clone(), "notiq:pw".into(), false, false, Some(TlsAcceptor::from(config)), stopped));

        // A client that does not check the self-signed certificate gets the page; the login is still needed.
        let c = reqwest::Client::builder().danger_accept_invalid_certs(true).build().unwrap();
        let url = format!("https://{addr}/a.txt");
        assert_eq!(c.get(&url).send().await.unwrap().status(), 401);
        let ok = c.get(&url).basic_auth("notiq", Some("pw")).send().await.unwrap();
        assert_eq!(ok.status(), 200);
        assert_eq!(ok.text().await.unwrap(), "secret");
        // A client that does check it refuses (nobody vouches for the certificate).
        assert!(reqwest::Client::new().get(&url).basic_auth("notiq", Some("pw")).send().await.is_err());
        // Plain HTTP to the TLS port gets nothing.
        assert!(reqwest::Client::new().get(format!("http://{addr}/a.txt")).basic_auth("notiq", Some("pw")).send().await.is_err());
        assert_eq!(fp.len(), 95);
        stop.send(true).unwrap();
        std::fs::remove_dir_all(&dir).ok();
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
        tokio::spawn(run(listener, dir.clone(), "notiq:pw".into(), false, false, None, stopped));

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
        let html = browser.text().await.unwrap();
        assert!(html.contains("Search this folder"));
        // The app icon is the favicon (no placeholder left over).
        assert!(html.contains("rel=\"icon\" type=\"image/png\" href=\"data:image/png;base64,") && !html.contains("__FAVICON__") && !html.contains("__TOUCH_ICON__"));
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
