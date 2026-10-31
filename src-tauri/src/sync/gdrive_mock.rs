//! A tiny local fake of the Google OAuth + Drive v3 endpoints the provider uses,
//! so request/response, retry, pagination and resumable-upload logic is tested
//! over real HTTP without the network. Supports scripted fault injection.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use base64::Engine;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::contract_tests::{block_on, pattern, run_contract};
use super::gdrive::*;
use super::provider::{ProviderAuth, ProviderError, StorageProvider};

#[derive(Clone)]
struct MFile {
    name: String,
    parents: Vec<String>,
    data: Vec<u8>,
    version: u64,
    modified_s: i64,
}

struct Session {
    file_id: Option<String>,
    name: String,
    total: usize,
    received: Vec<u8>,
}

/// A scripted reply. `status == 0` drops the connection without answering.
#[derive(Clone)]
pub struct Canned {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    /// Resumable chunk only: store this many bytes of the chunk before failing.
    pub keep_bytes: usize,
}

impl Canned {
    pub fn status(status: u16) -> Self {
        Self { status, headers: vec![], body: String::new(), keep_bytes: 0 }
    }
    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
    pub fn body(mut self, b: &str) -> Self {
        self.body = b.into();
        self
    }
}

#[derive(Default)]
pub struct MockState {
    files: BTreeMap<String, MFile>,
    sessions: HashMap<String, Session>,
    next_id: u64,
    clock_s: i64,
    pub access_token: String,
    pub refresh_token: String,
    access_n: u64,
    pub expected_challenge: Option<String>,
    pub revoked: Vec<String>,
    pub page_size: usize,
    faults: VecDeque<(String, String, Canned)>,
    /// `METHOD path` of every request.
    pub log: Vec<String>,
    /// `scope` returned by the code exchange (None: omitted, as before).
    pub granted_scope: Option<String>,
    /// The page the loopback listener answered the OAuth redirect with.
    pub callback_html: Option<String>,
}

pub struct MockDrive {
    pub base: String,
    pub state: Arc<Mutex<MockState>>,
}

fn rfc3339(secs: i64) -> String {
    // civil from days (Howard Hinnant)
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

impl MockState {
    fn tick(&mut self) -> i64 {
        self.clock_s += 1;
        self.clock_s
    }

    fn file_json(id: &str, f: &MFile) -> Value {
        json!({ "id": id, "name": f.name, "size": f.data.len().to_string(), "version": f.version.to_string(), "modifiedTime": rfc3339(f.modified_s) })
    }

    fn create(&mut self, name: &str, parents: Vec<String>, data: Vec<u8>) -> Value {
        self.next_id += 1;
        let id = format!("f{:04}", self.next_id);
        let f = MFile { name: name.into(), parents, data, version: 1, modified_s: self.tick() };
        let j = Self::file_json(&id, &f);
        self.files.insert(id, f);
        j
    }

    fn update(&mut self, id: &str, data: Vec<u8>) -> Option<Value> {
        let now = self.tick();
        let f = self.files.get_mut(id)?;
        f.data = data;
        f.version += 1;
        f.modified_s = now;
        Some(Self::file_json(id, f))
    }

    pub fn add_raw(&mut self, name: &str, data: &[u8]) -> String {
        let j = self.create(name, vec!["appDataFolder".into()], data.to_vec());
        j["id"].as_str().unwrap().to_string()
    }

    pub fn ids_named(&self, name: &str) -> Vec<String> {
        self.files.iter().filter(|(_, f)| f.name == name).map(|(id, _)| id.clone()).collect()
    }

    pub fn count(&self, method_path_prefix: &str) -> usize {
        self.log.iter().filter(|l| l.starts_with(method_path_prefix)).count()
    }
}

struct Req {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn json_resp(status: u16, v: Value) -> Resp {
    Resp { status, headers: vec![("Content-Type".into(), "application/json".into())], body: v.to_string().into_bytes() }
}

fn err_resp(status: u16, reason: &str) -> Resp {
    json_resp(status, json!({"error": {"code": status, "message": reason, "errors": [{"reason": reason}]}}))
}

fn form(body: &[u8]) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://x/?{}", String::from_utf8_lossy(body)))
        .map(|u| u.query_pairs().into_owned().collect())
        .unwrap_or_default()
}

/// `name = '...'` from a Drive query.
fn q_name(q: &str) -> Option<String> {
    let rest = q.strip_prefix("name = '")?;
    let mut out = String::new();
    let mut it = rest.chars();
    while let Some(c) = it.next() {
        match c {
            '\\' => out.push(it.next()?),
            '\'' => return Some(out),
            c => out.push(c),
        }
    }
    None
}

fn parse_multipart(ctype: &str, body: &[u8]) -> Option<(Value, Vec<u8>)> {
    let boundary = ctype.split("boundary=").nth(1)?.trim();
    let delim = format!("--{boundary}\r\n");
    let text = body;
    let find = |hay: &[u8], needle: &[u8], from: usize| hay[from..].windows(needle.len()).position(|w| w == needle).map(|p| p + from);
    let p1 = find(text, delim.as_bytes(), 0)? + delim.len();
    let h1 = find(text, b"\r\n\r\n", p1)? + 4;
    let e1 = find(text, format!("\r\n--{boundary}\r\n").as_bytes(), h1)?;
    let meta: Value = serde_json::from_slice(&text[h1..e1]).ok()?;
    let p2 = e1 + 2 + delim.len();
    let h2 = find(text, b"\r\n\r\n", p2)? + 4;
    let end_marker = format!("\r\n--{boundary}--");
    let e2 = text.windows(end_marker.len()).rposition(|w| w == end_marker.as_bytes())?;
    Some((meta, text[h2..e2].to_vec()))
}

impl MockDrive {
    pub async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(MockState {
            refresh_token: "rt-1".into(),
            page_size: 2,
            clock_s: 1_793_000_000,
            ..Default::default()
        }));
        let (st, b) = (state.clone(), base.clone());
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                let (st, b) = (st.clone(), b.clone());
                tokio::spawn(async move {
                    let _ = serve(sock, st, b).await;
                });
            }
        });
        Self { base, state }
    }

    pub fn inject(&self, method: &str, path_prefix: &str, c: Canned) {
        self.state.lock().unwrap().faults.push_back((method.into(), path_prefix.into(), c));
    }

    pub fn st(&self) -> std::sync::MutexGuard<'_, MockState> {
        self.state.lock().unwrap()
    }

    /// The page the loopback listener sent the mock browser (its thread stores it just after `connect` returns).
    pub async fn callback_page(&self) -> String {
        for _ in 0..200 {
            if let Some(p) = self.st().callback_html.clone() {
                return p;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("the mock browser never got the callback page");
    }

    /// A provider wired to this mock, with fast retries and a 1 MiB resumable threshold.
    pub fn provider(&self, signed_in: bool) -> (GoogleDriveProvider, Arc<MemorySecretStore>) {
        let store = Arc::new(MemorySecretStore::default());
        if signed_in {
            store.save(r#"{"refresh_token":"rt-1","email":"user@example.com"}"#).unwrap();
        }
        let st = self.state.clone();
        let opener: UrlOpener = Arc::new(move |url: &str| {
            // Play the browser: remember the PKCE challenge, then hit the loopback redirect.
            let u = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
            let q: HashMap<String, String> = u.query_pairs().into_owned().collect();
            st.lock().unwrap().expected_challenge = q.get("code_challenge").cloned();
            let redirect = q["redirect_uri"].clone();
            let state = q["state"].clone();
            let st = st.clone();
            std::thread::spawn(move || {
                let addr = redirect.trim_start_matches("http://").to_string();
                // A favicon probe first: it must be ignored.
                for target in ["/favicon.ico".to_string(), format!("/?state={state}&code=good-code&scope=x")] {
                    let mut s = std::net::TcpStream::connect(&addr).unwrap();
                    write!(s, "GET {target} HTTP/1.1\r\nHost: {addr}\r\n\r\n").unwrap();
                    let mut out = String::new();
                    let _ = s.read_to_string(&mut out);
                    if target.contains("code=") {
                        st.lock().unwrap().callback_html = Some(out);
                    }
                }
            });
            Ok(())
        });
        let cfg = DriveConfig {
            endpoints: Endpoints::at(&self.base),
            oauth: Some(OAuthClient { client_id: "test-client".into(), client_secret: "test-secret".into() }),
            store: store.clone(),
            opener: Some(opener),
            retry: RetryPolicy { max_attempts: 4, base_delay_ms: 1, max_delay_ms: 4, max_retry_after_s: 2, default_retry_after_s: 0 },
            max_object_bytes: 8 * 1024 * 1024,
            resumable_threshold: 1024 * 1024,
            chunk_size: 512 * 1024,
            login_timeout: Duration::from_secs(10),
        };
        (GoogleDriveProvider::new(cfg).unwrap(), store)
    }
}

async fn serve(mut sock: TcpStream, st: Arc<Mutex<MockState>>, base: String) -> std::io::Result<()> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 65536];
    let head_end = loop {
        let n = sock.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(p) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break p + 4;
        }
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("").to_string();
    let target = first.next().unwrap_or("/").to_string();
    let headers: HashMap<String, String> = lines
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())))
        .collect();
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = buf[head_end..].to_vec();
    while body.len() < len {
        let n = sock.read(&mut tmp).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    let u = reqwest::Url::parse(&format!("http://x{target}")).unwrap();
    let req = Req {
        method,
        path: u.path().to_string(),
        query: u.query_pairs().into_owned().collect(),
        headers,
        body,
    };
    let resp = handle(&st, &base, &req);
    let Some(r) = resp else { return Ok(()) }; // dropped connection
    let mut out = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n", r.status, r.body.len());
    for (k, v) in &r.headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    sock.write_all(out.as_bytes()).await?;
    sock.write_all(&r.body).await?;
    sock.shutdown().await
}

fn handle(st: &Arc<Mutex<MockState>>, base: &str, req: &Req) -> Option<Resp> {
    let mut s = st.lock().unwrap();
    s.log.push(format!("{} {}", req.method, req.path));

    if let Some(i) = s.faults.iter().position(|(m, p, _)| *m == req.method && req.path.starts_with(p.as_str())) {
        let (_, _, c) = s.faults.remove(i).unwrap();
        if c.keep_bytes > 0 {
            if let Some(sess) = req.path.strip_prefix("/session/").and_then(|id| s.sessions.get_mut(id)) {
                let keep = c.keep_bytes.min(req.body.len());
                sess.received.extend_from_slice(&req.body[..keep]);
            }
        }
        if c.status == 0 {
            return None;
        }
        return Some(Resp { status: c.status, headers: c.headers, body: c.body.into_bytes() });
    }

    let p = req.path.as_str();
    if req.method == "POST" && p == "/token" {
        let f = form(&req.body);
        assert_eq!(f.get("client_id").map(String::as_str), Some("test-client"));
        assert_eq!(f.get("client_secret").map(String::as_str), Some("test-secret"));
        return Some(match f.get("grant_type").map(String::as_str) {
            Some("authorization_code") => {
                let verifier = f.get("code_verifier").cloned().unwrap_or_default();
                let pkce_ok = s.expected_challenge.as_deref() == Some(pkce_challenge(&verifier).as_str());
                if f.get("code").map(String::as_str) != Some("good-code") || !pkce_ok || !f.contains_key("redirect_uri") {
                    json_resp(400, json!({"error": "invalid_grant"}))
                } else {
                    s.access_n += 1;
                    s.access_token = format!("at-{}", s.access_n);
                    let idt = format!("h.{}.sig", B64.encode(br#"{"email":"user@example.com"}"#));
                    let mut body = json!({"access_token": s.access_token, "expires_in": 3599, "refresh_token": s.refresh_token, "id_token": idt});
                    if let Some(scope) = &s.granted_scope {
                        body["scope"] = json!(scope);
                    }
                    json_resp(200, body)
                }
            }
            Some("refresh_token") if f.get("refresh_token") == Some(&s.refresh_token) && !s.revoked.contains(&s.refresh_token) => {
                s.access_n += 1;
                s.access_token = format!("at-{}", s.access_n);
                json_resp(200, json!({"access_token": s.access_token, "expires_in": 3599}))
            }
            _ => json_resp(400, json!({"error": "invalid_grant"})),
        });
    }
    if req.method == "POST" && p == "/revoke" {
        let t = form(&req.body).get("token").cloned().unwrap_or_default();
        s.revoked.push(t);
        return Some(json_resp(200, json!({})));
    }

    let authed = req.headers.get("authorization").map(String::as_str) == Some(&format!("Bearer {}", s.access_token)) && !s.access_token.is_empty();
    if !authed {
        return Some(err_resp(401, "authError"));
    }

    // files.list
    if req.method == "GET" && p == "/files" {
        assert_eq!(req.query.get("spaces").map(String::as_str), Some("appDataFolder"));
        let q = req.query.get("q").cloned().unwrap_or_default();
        assert!(q.contains("'appDataFolder' in parents and trashed = false"), "query scoped to the app folder: {q}");
        let want = q_name(&q);
        let all: Vec<Value> = s
            .files
            .iter()
            .filter(|(_, f)| f.parents.iter().any(|x| x == "appDataFolder"))
            .filter(|(_, f)| want.as_ref().is_none_or(|n| *n == f.name))
            .map(|(id, f)| MockState::file_json(id, f))
            .collect();
        let start: usize = req.query.get("pageToken").and_then(|t| t.parse().ok()).unwrap_or(0);
        let end = (start + s.page_size).min(all.len());
        let mut v = json!({ "files": all[start.min(all.len())..end] });
        if end < all.len() {
            v["nextPageToken"] = json!(end.to_string());
        }
        return Some(json_resp(200, v));
    }
    if let Some(id) = p.strip_prefix("/files/") {
        return Some(match req.method.as_str() {
            "GET" => {
                assert_eq!(req.query.get("alt").map(String::as_str), Some("media"));
                match s.files.get(id) {
                    Some(f) => Resp { status: 200, headers: vec![], body: f.data.clone() },
                    None => err_resp(404, "notFound"),
                }
            }
            "DELETE" => match s.files.remove(id) {
                Some(_) => Resp { status: 204, headers: vec![], body: vec![] },
                None => err_resp(404, "notFound"),
            },
            _ => err_resp(400, "badRequest"),
        });
    }

    // uploads
    if p == "/upload" || p.starts_with("/upload/") {
        let existing = p.strip_prefix("/upload/").map(str::to_string);
        if let Some(id) = &existing {
            if !s.files.contains_key(id) {
                return Some(err_resp(404, "notFound"));
            }
        }
        let ty = req.query.get("uploadType").cloned().unwrap_or_default();
        let expect_method = if existing.is_some() { "PATCH" } else { "POST" };
        assert_eq!(req.method, expect_method, "create = POST, update = PATCH");
        if ty == "multipart" {
            let (meta, data) = parse_multipart(req.headers.get("content-type").map(String::as_str).unwrap_or(""), &req.body).expect("multipart body");
            return Some(match existing {
                Some(id) => {
                    assert!(meta.get("parents").is_none(), "update must not set parents");
                    json_resp(200, s.update(&id, data).unwrap())
                }
                None => {
                    let parents: Vec<String> = meta["parents"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
                    assert_eq!(parents, ["appDataFolder"]);
                    json_resp(200, s.create(meta["name"].as_str().unwrap(), parents, data))
                }
            });
        }
        if ty == "resumable" {
            let meta: Value = serde_json::from_slice(&req.body).unwrap_or(json!({}));
            let total: usize = req.headers.get("x-upload-content-length").and_then(|v| v.parse().ok()).expect("upload length");
            let name = meta["name"].as_str().unwrap_or("").to_string();
            if existing.is_none() {
                assert_eq!(meta["parents"], json!(["appDataFolder"]));
            }
            s.next_id += 1;
            let sid = format!("s{}", s.next_id);
            s.sessions.insert(sid.clone(), Session { file_id: existing, name, total, received: vec![] });
            return Some(Resp { status: 200, headers: vec![("Location".into(), format!("{base}/session/{sid}"))], body: vec![] });
        }
        return Some(err_resp(400, "badRequest"));
    }

    if let Some(sid) = p.strip_prefix("/session/") {
        assert_eq!(req.method, "PUT");
        let Some(sess) = s.sessions.get_mut(sid) else { return Some(err_resp(404, "notFound")) };
        let cr = req.headers.get("content-range").cloned().unwrap_or_default();
        let spec = cr.strip_prefix("bytes ").expect("content-range");
        let (range, total) = spec.split_once('/').unwrap();
        assert_eq!(total.parse::<usize>().unwrap(), sess.total);
        let range_hdr = |n: usize| if n == 0 { vec![] } else { vec![("Range".to_string(), format!("bytes=0-{}", n - 1))] };
        if range != "*" {
            let (a, b) = range.split_once('-').unwrap();
            let (a, b): (usize, usize) = (a.parse().unwrap(), b.parse().unwrap());
            assert_eq!(b + 1 - a, req.body.len(), "chunk length matches Content-Range");
            if a != sess.received.len() {
                return Some(Resp { status: 308, headers: range_hdr(sess.received.len()), body: vec![] });
            }
            if b + 1 != sess.total && !req.body.len().is_multiple_of(256 * 1024) {
                return Some(err_resp(400, "chunkNotAligned"));
            }
            sess.received.extend_from_slice(&req.body);
        }
        if sess.received.len() < sess.total {
            return Some(Resp { status: 308, headers: range_hdr(sess.received.len()), body: vec![] });
        }
        let sess = s.sessions.remove(sid).unwrap();
        let j = match &sess.file_id {
            Some(id) => s.update(id, sess.received).unwrap(),
            None => s.create(&sess.name, vec!["appDataFolder".into()], sess.received),
        };
        return Some(json_resp(200, j));
    }
    Some(err_resp(404, "notFound"))
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[test]
fn drive_provider_passes_the_contract_against_the_mock() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        run_contract(&p, "ct/").await;
        let st = m.st();
        assert!(st.count("PUT /session/") >= 12, "large object used chunked resumable upload");
        assert!(st.files.is_empty());
    });
}

#[test]
fn connect_without_the_drive_box_ticked_fails_and_saves_nothing() {
    block_on(async {
        let m = MockDrive::start().await;
        m.st().granted_scope = Some("openid https://www.googleapis.com/auth/userinfo.email".into());
        let (p, store) = m.provider(false);
        let err = p.connect().await.unwrap_err();
        assert!(matches!(&err, ProviderError::Other(msg) if msg.contains("tick the Google Drive box")), "{err:?}");
        assert_eq!(store.load().unwrap(), None, "nothing stored");
        assert_eq!(p.account(), None);
        let page = m.callback_page().await;
        assert!(page.contains("Couldn&#x27;t connect") || page.contains("Couldn't connect Google Drive"));
        assert!(page.contains("status err") && !page.contains("Signed in as"));
    });
}

#[test]
fn connect_page_reports_success_only_after_the_exchange() {
    block_on(async {
        let m = MockDrive::start().await;
        m.st().granted_scope = Some(format!("openid {} email", super::gdrive::DRIVE_SCOPE));
        let (p, _store) = m.provider(false);
        p.connect().await.unwrap();
        let page = m.callback_page().await;
        assert!(page.contains("You're connected") && page.contains("Signed in as <strong>user@example.com</strong>"));
    });
}

#[test]
fn connect_runs_pkce_loopback_flow_and_stores_only_in_the_keychain() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, store) = m.provider(false);
        assert_eq!(p.account(), None);
        assert_eq!(p.list("").await, Err(ProviderError::Auth), "not connected");
        let acct = p.connect().await.unwrap();
        assert_eq!(acct.label, "user@example.com");
        assert_eq!(p.account().unwrap().label, "user@example.com");
        let saved: Value = serde_json::from_str(&store.load().unwrap().unwrap()).unwrap();
        assert_eq!(saved["refresh_token"], "rt-1");
        assert!(saved.get("access_token").is_none(), "access token is memory-only");
        // The cached access token from the code exchange is used directly.
        p.put("vault.meta", b"m").await.unwrap();
        assert_eq!(m.st().count("POST /token"), 1);

        p.disconnect().await.unwrap();
        assert_eq!(store.load().unwrap(), None);
        assert_eq!(m.st().revoked, ["rt-1"]);
        assert_eq!(p.account(), None);
        assert_eq!(p.get("vault.meta").await, Err(ProviderError::Auth));
    });
}

#[test]
fn expired_access_token_refreshes_once_then_reports_auth() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        p.put("a", b"1").await.unwrap();
        // Server-side expiry: the next call gets 401, refreshes, succeeds.
        m.st().access_token = "rotated".into();
        let before = m.st().count("POST /token");
        assert_eq!(p.get("a").await.unwrap(), b"1");
        assert_eq!(m.st().count("POST /token"), before + 1);
        // Refresh token revoked: refresh fails → Auth (no retry storm).
        m.st().access_token = "rotated-again".into();
        m.st().revoked.push("rt-1".into());
        assert_eq!(p.get("a").await, Err(ProviderError::Auth));
        // A 401 that persists after a successful refresh is Auth too.
        m.st().revoked.clear();
        for _ in 0..2 {
            m.inject("GET", "/files", Canned::status(401).body(r#"{"error":{"code":401}}"#));
        }
        assert_eq!(p.list("").await, Err(ProviderError::Auth));
    });
}

#[test]
fn transient_errors_are_retried_with_backoff() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        p.put("a", b"1").await.unwrap();
        m.inject("GET", "/files", Canned::status(503));
        m.inject("GET", "/files", Canned::status(429).header("Retry-After", "0"));
        m.inject("GET", "/files", Canned::status(0)); // dropped connection
        assert_eq!(p.get("a").await.unwrap(), b"1");
        let rl = r#"{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}]}}"#;
        m.inject("GET", "/files/", Canned::status(403).body(rl));
        assert_eq!(p.get("a").await.unwrap(), b"1");
    });
}

#[test]
fn retries_give_up_with_the_right_error() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        for _ in 0..4 {
            m.inject("GET", "/files", Canned::status(0));
        }
        assert_eq!(p.list("").await, Err(ProviderError::Offline));
        // Retry-After longer than we're willing to wait goes back to the caller.
        m.inject("GET", "/files", Canned::status(429).header("Retry-After", "120"));
        assert_eq!(p.list("").await, Err(ProviderError::RateLimited { retry_after_s: 120 }));
        assert_eq!(m.st().count("GET /files"), 5, "no retry for the long Retry-After");
        // Non-retryable errors fail at once.
        let full = r#"{"error":{"code":403,"errors":[{"reason":"storageQuotaExceeded"}]}}"#;
        m.inject("POST", "/upload", Canned::status(403).body(full));
        assert!(matches!(p.put("a", b"x").await, Err(ProviderError::Other(m)) if m.contains("full")));
        m.inject("POST", "/upload", Canned::status(413));
        assert_eq!(p.put("a", b"x").await, Err(ProviderError::TooLarge));
    });
}

#[test]
fn list_paginates_filters_by_prefix_and_ignores_foreign_names() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        {
            let mut st = m.st();
            st.page_size = 3;
            for i in 0..10 {
                st.add_raw(&format!("devices/d{i:02}.nqs"), b"x");
            }
            st.add_raw("blobs/b1", b"yy");
            st.add_raw("bad name with spaces", b"z");
        }
        let devices = p.list("devices/").await.unwrap();
        assert_eq!(devices.len(), 10);
        assert_eq!(devices[0].name, "devices/d00.nqs");
        assert_eq!(p.list("").await.unwrap().len(), 11, "invalid names are skipped");
        assert!(m.st().count("GET /files") >= 8, "followed nextPageToken");
    });
}

#[test]
fn duplicate_names_resolve_to_the_newest_and_put_cleans_up() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        {
            let mut st = m.st();
            st.add_raw("devices/x.nqs", b"older");
            st.add_raw("devices/x.nqs", b"newer");
        }
        assert_eq!(p.get("devices/x.nqs").await.unwrap(), b"newer");
        let listed = p.list("devices/").await.unwrap();
        assert_eq!((listed.len(), listed[0].size), (1, 5));
        p.put("devices/x.nqs", b"latest").await.unwrap();
        assert_eq!(m.st().ids_named("devices/x.nqs").len(), 1, "older duplicate removed");
        assert_eq!(p.get("devices/x.nqs").await.unwrap(), b"latest");
        m.st().add_raw("devices/x.nqs", b"dup");
        p.delete("devices/x.nqs").await.unwrap();
        assert!(m.st().ids_named("devices/x.nqs").is_empty(), "delete removes every duplicate");
    });
}

#[test]
fn resumable_upload_resumes_after_partial_chunk_and_errors() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        let data = pattern(3 * 1024 * 1024 + 7, 42);
        // First chunk: the server stores half of it, then fails; the status probe
        // that follows is dropped too. The client must resume from byte 256 KiB.
        m.inject("PUT", "/session/", Canned { keep_bytes: 256 * 1024, ..Canned::status(503) });
        m.inject("PUT", "/session/", Canned::status(0));
        let obj = p.put("blobs/big", &data).await.unwrap();
        assert!(m.st().faults.is_empty(), "both injected failures were hit");
        // failed chunk + dropped probe + re-send (answered 308 "have 256 KiB") + 6 chunks from 256 KiB on
        assert_eq!(m.st().count("PUT /session/"), 3 + 6);
        assert_eq!(obj.size, data.len() as u64);
        assert_eq!(p.get("blobs/big").await.unwrap(), data);

        // Overwrite through a resumable session whose session expires once (404 → restart).
        let data2 = pattern(2 * 1024 * 1024, 7);
        m.inject("PUT", "/session/", Canned::status(404).body(r#"{"error":{"code":404}}"#));
        let obj2 = p.put("blobs/big", &data2).await.unwrap();
        assert_ne!(obj2.revision, obj.revision);
        assert_eq!(p.get("blobs/big").await.unwrap(), data2);
        assert_eq!(m.st().ids_named("blobs/big").len(), 1, "updated in place");
        assert!(m.st().count("PATCH /upload/") >= 2, "update sessions use PATCH on the file");
    });
}

#[test]
fn failed_upload_leaves_old_content() {
    block_on(async {
        let m = MockDrive::start().await;
        let (p, _) = m.provider(true);
        p.put("devices/a.nqs", b"v1").await.unwrap();
        for _ in 0..4 {
            m.inject("PATCH", "/upload/", Canned::status(503));
        }
        assert!(p.put("devices/a.nqs", b"v2").await.is_err());
        assert_eq!(p.get("devices/a.nqs").await.unwrap(), b"v1");
        // Large: every chunk attempt fails → session abandoned, old content intact.
        let big = pattern(2 * 1024 * 1024, 1);
        for _ in 0..20 {
            m.inject("PUT", "/session/", Canned::status(0));
        }
        assert_eq!(p.put("devices/a.nqs", &big).await, Err(ProviderError::Offline));
        assert_eq!(p.get("devices/a.nqs").await.unwrap(), b"v1");
        m.state.lock().unwrap().faults.clear();
    });
}
