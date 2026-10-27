//! Google Drive storage backend (hidden `appDataFolder`).
//!
//! The only Drive permission requested is `drive.appdata`: Notiq can see only
//! its own hidden app folder, never the user's other files. Sign-in is the
//! installed-app flow with PKCE over a loopback redirect; the refresh token is
//! kept in the OS keychain. Only ciphertext is uploaded, under random names.
//!
//! The OAuth client ID is public. Google's token endpoint also wants the
//! "client secret" of a Desktop client, which Google itself documents as not
//! confidential for installed apps; it is injected at build time
//! (`NOTIQ_GOOGLE_CLIENT_SECRET`) and never committed to the repository.

use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::Mutex,
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as B64}, Engine};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::sync::{self, data_file, random_name, Backend, MAX_FILE};
use crate::vault::atomic_write;

const CLIENT_ID: &str = "639536443788-jo6ec87mf9qfafpbb1qqskoj0gca8jra.apps.googleusercontent.com";
const CLIENT_SECRET: Option<&str> = option_env!("NOTIQ_GOOGLE_CLIENT_SECRET");
const SCOPES: &str = "https://www.googleapis.com/auth/drive.appdata openid email";
const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";
const STATE_NAME: &str = "notiq-sync-state.nqs";
const SERVICE: &str = "notiq-vault-gdrive";
const ACCOUNT: &str = "refresh-token";
const CFG_FILE: &str = "gdrive_config.json";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Serialize, Deserialize)]
struct Config { email: String }

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

fn net(e: reqwest::Error) -> String { e.without_url().to_string() }

fn secret() -> Result<&'static str, String> {
    CLIENT_SECRET.ok_or_else(|| "Google Drive sign-in isn't enabled in this build of Notiq".to_string())
}

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    B64.encode(b)
}

/// The signed-in Drive.
pub struct GDrive { refresh: String, http: reqwest::Client, access: Mutex<Option<(String, Instant)>> }

impl GDrive {
    fn new(refresh: String, access: Option<(String, Instant)>) -> Result<Self, String> {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(120)).build().map_err(|e| e.to_string())?;
        Ok(Self { refresh, http, access: Mutex::new(access) })
    }

    pub(crate) fn load(app: &AppHandle) -> Result<Option<Self>, String> {
        if !data_file(app, CFG_FILE)?.exists() { return Ok(None); }
        match token_entry()?.get_password() {
            Ok(t) => Self::new(t, None).map(Some),
            Err(_) => Ok(None),
        }
    }

    pub(crate) fn detail(app: &AppHandle) -> Option<String> {
        let cfg: Config = serde_json::from_str(&fs::read_to_string(data_file(app, CFG_FILE).ok()?).ok()?).ok()?;
        token_entry().ok()?.get_password().ok()?;
        Some(format!("Google Drive ({})", cfg.email))
    }

    pub(crate) fn clear(app: &AppHandle) -> Result<(), String> {
        if let Ok(e) = token_entry() { let _ = e.delete_credential(); }
        let _ = fs::remove_file(data_file(app, CFG_FILE)?);
        Ok(())
    }

    /// A valid access token, refreshed when it is about to expire.
    async fn token(&self) -> Result<String, String> {
        if let Some((t, exp)) = self.access.lock().map_err(|_| "lock")?.as_ref() {
            if *exp > Instant::now() + Duration::from_secs(60) { return Ok(t.clone()); }
        }
        let resp = self.http.post(TOKEN_URL)
            .form(&[("client_id", CLIENT_ID), ("client_secret", secret()?), ("refresh_token", self.refresh.as_str()), ("grant_type", "refresh_token")])
            .send().await.map_err(net)?;
        let status = resp.status();
        let v: Value = resp.json().await.map_err(net)?;
        let t = v["access_token"].as_str().ok_or_else(|| {
            if v["error"].as_str() == Some("invalid_grant") {
                "Google sign-in expired or was revoked. Reconnect Google Drive in Settings.".to_string()
            } else {
                format!("Google sign-in failed ({})", status.as_u16())
            }
        })?.to_string();
        let ttl = v["expires_in"].as_u64().unwrap_or(3000);
        *self.access.lock().map_err(|_| "lock")? = Some((t.clone(), Instant::now() + Duration::from_secs(ttl)));
        Ok(t)
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response, String> {
        if resp.status().is_success() { return Ok(resp); }
        let code = resp.status().as_u16();
        let msg = resp.json::<Value>().await.ok()
            .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| "request failed".into());
        Err(format!("Google Drive error {code}: {msg}"))
    }

    /// Create a file in the app folder (multipart/related upload); returns its id.
    async fn create(&self, name: &str, bytes: Vec<u8>) -> Result<String, String> {
        if bytes.len() as u64 > MAX_FILE + 1024 * 1024 { return Err("File is too large".into()); }
        let boundary = format!("nq{}", random_b64(12).replace(['-', '_'], "x"));
        let meta = json!({ "name": name, "parents": ["appDataFolder"] }).to_string();
        let mut body = Vec::with_capacity(bytes.len() + meta.len() + 256);
        body.extend_from_slice(format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").as_bytes());
        body.extend_from_slice(&bytes);
        body.extend_from_slice(format!("\r\n--{boundary}--").as_bytes());
        let resp = self.http.post(UPLOAD_URL)
            .query(&[("uploadType", "multipart"), ("fields", "id")])
            .bearer_auth(self.token().await?)
            .header("Content-Type", format!("multipart/related; boundary={boundary}"))
            .body(body).send().await.map_err(net)?;
        let v: Value = Self::check(resp).await?.json().await.map_err(net)?;
        v["id"].as_str().map(str::to_string).ok_or_else(|| "Unexpected reply from Google Drive".to_string())
    }

    pub(crate) async fn put(&self, bytes: Vec<u8>) -> Result<String, String> {
        self.create(&random_name(), bytes).await
    }

    pub(crate) async fn get(&self, id: &str) -> Result<Vec<u8>, String> {
        let resp = self.http.get(format!("{FILES_URL}/{id}"))
            .query(&[("alt", "media")]).bearer_auth(self.token().await?).send().await.map_err(net)?;
        let bytes = Self::check(resp).await?.bytes().await.map_err(net)?;
        if bytes.len() as u64 > MAX_FILE + 1024 * 1024 { return Err("Downloaded file is unexpectedly large".into()); }
        Ok(bytes.to_vec())
    }

    pub(crate) async fn delete(&self, id: &str) {
        if let Ok(t) = self.token().await {
            let _ = self.http.delete(format!("{FILES_URL}/{id}")).bearer_auth(t).send().await;
        }
    }

    /// Ids of every sync-state file, newest first (normally just one).
    async fn state_ids(&self) -> Result<Vec<String>, String> {
        let q = format!("name = '{STATE_NAME}' and trashed = false");
        let resp = self.http.get(FILES_URL)
            .query(&[("spaces", "appDataFolder"), ("q", q.as_str()), ("orderBy", "modifiedTime desc"), ("fields", "files(id)"), ("pageSize", "10")])
            .bearer_auth(self.token().await?).send().await.map_err(net)?;
        let v: Value = Self::check(resp).await?.json().await.map_err(net)?;
        Ok(v["files"].as_array().map(|a| a.iter().filter_map(|f| f["id"].as_str().map(str::to_string)).collect()).unwrap_or_default())
    }

    pub(crate) async fn read_state(&self) -> Result<Option<Vec<u8>>, String> {
        match self.state_ids().await?.first() {
            Some(id) => Ok(Some(self.get(id).await?)),
            None => Ok(None),
        }
    }

    pub(crate) async fn write_state(&self, bytes: Vec<u8>) -> Result<(), String> {
        let ids = self.state_ids().await?;
        match ids.first() {
            Some(id) => {
                let resp = self.http.patch(format!("{UPLOAD_URL}/{id}"))
                    .query(&[("uploadType", "media")]).bearer_auth(self.token().await?)
                    .header("Content-Type", "application/octet-stream").body(bytes).send().await.map_err(net)?;
                Self::check(resp).await?;
                for dup in &ids[1..] { self.delete(dup).await; } // two devices created it at once
            }
            None => { self.create(STATE_NAME, bytes).await?; }
        }
        Ok(())
    }
}

// ─── sign-in ─────────────────────────────────────────────────────────────────

struct SignIn { refresh: String, access: String, ttl: u64, email: String }

/// Opens the browser, waits for Google's redirect on a loopback port, exchanges the code.
async fn authorize(app: &AppHandle) -> Result<SignIn, String> {
    let secret = secret()?;
    let verifier = random_b64(48);
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64(16);

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect = format!("http://127.0.0.1:{port}");

    let url = reqwest::Url::parse_with_params(AUTH_URL, &[
        ("client_id", CLIENT_ID), ("redirect_uri", redirect.as_str()), ("response_type", "code"),
        ("scope", SCOPES), ("code_challenge", challenge.as_str()), ("code_challenge_method", "S256"),
        ("state", state.as_str()), ("access_type", "offline"), ("prompt", "consent"),
    ]).map_err(|e| e.to_string())?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|e| format!("Couldn't open the browser: {e}"))?;

    let want = state.clone();
    let code = tauri::async_runtime::spawn_blocking(move || wait_for_code(listener, &want))
        .await.map_err(|e| e.to_string())??;

    let http = reqwest::Client::builder().timeout(Duration::from_secs(60)).build().map_err(|e| e.to_string())?;
    let resp = http.post(TOKEN_URL)
        .form(&[("client_id", CLIENT_ID), ("client_secret", secret), ("code", code.as_str()), ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"), ("code_verifier", verifier.as_str())])
        .send().await.map_err(net)?;
    let status = resp.status();
    let v: Value = resp.json().await.map_err(net)?;
    let refresh = v["refresh_token"].as_str().ok_or_else(|| format!("Google sign-in failed ({})", status.as_u16()))?.to_string();
    let access = v["access_token"].as_str().ok_or("Google sign-in failed")?.to_string();
    let email = v["id_token"].as_str().and_then(email_from_id_token).unwrap_or_else(|| "Google account".into());
    Ok(SignIn { refresh, access, ttl: v["expires_in"].as_u64().unwrap_or(3000), email })
}

/// Display only: the id_token comes straight from Google over TLS.
fn email_from_id_token(t: &str) -> Option<String> {
    let payload = B64.decode(t.split('.').nth(1)?).ok()?;
    serde_json::from_slice::<Value>(&payload).ok()?["email"].as_str().map(str::to_string)
}

fn wait_for_code(listener: TcpListener, want_state: &str) -> Result<String, String> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        if Instant::now() > deadline { return Err("Sign-in timed out. Try again.".into()); }
        let (mut s, _) = match listener.accept() {
            Ok(x) => x,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => { std::thread::sleep(Duration::from_millis(120)); continue; }
            Err(e) => return Err(e.to_string()),
        };
        let _ = s.set_nonblocking(false);
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 4096];
        let n = s.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let path = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/");
        let Ok(u) = reqwest::Url::parse(&format!("http://127.0.0.1{path}")) else { continue };
        let pairs: Vec<(String, String)> = u.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let get = |k: &str| pairs.iter().find(|(a, _)| a == k).map(|(_, b)| b.clone());
        let mut reply = |ok: bool, heading: &str, text: &str| {
            let html = callback_page(ok, heading, text);
            let _ = s.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{html}", html.len()).as_bytes());
        };
        if let Some(err) = get("error") {
            reply(false, "Sign-in was cancelled", "Nothing was connected. You can close this tab and try again from Notiq.");
            return Err(format!("Google sign-in was cancelled ({err})"));
        }
        match (get("code"), get("state")) {
            (Some(code), Some(st)) if st == want_state => {
                reply(true, "Notiq is connected to Google Drive", "Your encrypted notes will sync to Notiq's private app folder. Notiq can't see any other file in your Drive.");
                return Ok(code);
            }
            (Some(_), _) => { reply(false, "Sign-in didn't match", "This response wasn't for the sign-in Notiq started. Close this tab and try again from the app."); return Err("Sign-in response didn't match this request".into()); }
            _ => reply(false, "Waiting for sign-in", "Finish signing in with Google, then return here."), // favicon or probe request
        }
    }
}

/// The page the browser lands on after Google redirects back to the loopback port.
fn callback_page(ok: bool, heading: &str, text: &str) -> String {
    let icon = STANDARD.encode(include_bytes!("callback-icon.png"));
    let mark = if ok {
        r##"<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>"##
    } else {
        r##"<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 7v6M12 17v.01"/></svg>"##
    };
    format!(
        r##"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notiq</title>
<style>
:root{{--bg:#fbfaf8;--text:#1d1b17;--muted:#6a655b;--line:#dcd8ce;--accent:#9a6a0a}}
@media(prefers-color-scheme:dark){{:root{{--bg:#14130f;--text:#ece8dc;--muted:#a09a8a;--line:#2e2b22;--accent:#c9a84c}}}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
font:17px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}}
main{{width:min(460px,calc(100vw - 48px))}}
.brand{{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px;margin-bottom:40px}}
.brand img{{width:30px;height:30px;border-radius:8px}}
.badge{{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;border:1.5px solid var(--accent);color:var(--accent);margin-bottom:20px;animation:pop .5s cubic-bezier(.2,.9,.3,1.2) both}}
h1{{font-size:1.65rem;line-height:1.2;letter-spacing:-.02em;margin:0 0 12px}}
p{{margin:0;color:var(--muted)}}
.hint{{margin-top:28px;padding-top:18px;border-top:1px solid var(--line);font-size:14px}}
@keyframes pop{{from{{transform:scale(.6);opacity:0}}to{{transform:none;opacity:1}}}}
@media(prefers-reduced-motion:reduce){{.badge{{animation:none}}}}
</style></head><body><main>
<div class="brand"><img src="data:image/png;base64,{icon}" alt="">Notiq</div>
<div class="badge">{mark}</div>
<h1>{heading}</h1>
<p>{text}</p>
<p class="hint">You can close this tab and return to the Notiq window.</p>
</main></body></html>"##
    )
}

fn persist(app: &AppHandle, refresh: &str, email: &str) -> Result<(), String> {
    token_entry()?.set_password(refresh).map_err(|e| e.to_string())?;
    let cfg = serde_json::to_vec(&Config { email: email.into() }).map_err(|e| e.to_string())?;
    atomic_write(&data_file(app, CFG_FILE)?, &cfg)?;
    sync::set_provider(app, "gdrive")
}

// ─── commands ────────────────────────────────────────────────────────────────

/// Sign in with Google and select Drive as the storage. Returns the account email.
#[tauri::command]
pub async fn gdrive_connect(app: AppHandle) -> Result<String, String> {
    let s = authorize(&app).await?;
    persist(&app, &s.refresh, &s.email)?;
    Ok(s.email)
}

/// New machine: sign in, install the key file from Drive's sync-state document.
#[tauri::command]
pub async fn gdrive_bootstrap(app: AppHandle) -> Result<(), String> {
    let s = authorize(&app).await?;
    let access = Some((s.access.clone(), Instant::now() + Duration::from_secs(s.ttl)));
    let backend = Backend::Drive(GDrive::new(s.refresh.clone(), access)?);
    sync::bootstrap(&app, &backend).await
        .map_err(|e| if e == "No Notiq backup found" { "No Notiq backup found in this Google Drive".into() } else { e })?;
    persist(&app, &s.refresh, &s.email)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_is_read_from_an_id_token_payload() {
        let payload = B64.encode(br#"{"email":"a@b.co","sub":"1"}"#);
        assert_eq!(email_from_id_token(&format!("h.{payload}.s")).as_deref(), Some("a@b.co"));
        assert_eq!(email_from_id_token("garbage"), None);
    }

    #[test]
    fn callback_page_is_self_contained_html() {
        let p = callback_page(true, "Connected", "ok");
        assert!(p.contains("<h1>Connected</h1>") && p.contains("data:image/png;base64,"));
        assert!(!p.contains("http://") && !p.contains("https://"));
    }

    #[test]
    fn pkce_values_are_url_safe_and_unique() {
        let (a, b) = (random_b64(48), random_b64(48));
        assert_ne!(a, b);
        assert!(a.len() >= 43 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }
}
