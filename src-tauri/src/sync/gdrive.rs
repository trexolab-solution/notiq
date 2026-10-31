//! Google Drive [`StorageProvider`] (hidden `appDataFolder`, scope `drive.appdata`).
//!
//! * Sign-in: installed-app OAuth with a loopback redirect (`127.0.0.1:<random>`),
//!   PKCE S256, `state` check and a 180 s timeout. The browser is opened through an
//!   injected [`UrlOpener`] so this module has no Tauri dependency.
//! * Secrets: the refresh token (plus the account email, for display) lives in the
//!   OS keychain ([`KEYRING_SERVICE`] / [`KEYRING_ACCOUNT`]); the access token is
//!   cached in memory only. Nothing here ever hands a token to the webview.
//! * Client credentials come from the build environment (`NOTIQ_GOOGLE_CLIENT_ID`,
//!   `NOTIQ_GOOGLE_CLIENT_SECRET`); a build without them can't sign in. Google
//!   documents the "secret" of a Desktop client as not confidential (PKCE is the
//!   protection), but it is still never committed.
//! * Objects map 1:1 onto Drive files: the Drive file `name` is the full object
//!   name (with `/`), parent `appDataFolder`. If two files share a name (two
//!   devices created it at once) the newest wins and `put` removes the others.
//! * Small objects use one multipart upload; objects from [`RESUMABLE_THRESHOLD`]
//!   use a chunked resumable session that resumes after transient failures.
//! * 429/5xx/network errors are retried with exponential backoff + jitter,
//!   honouring `Retry-After`; a 401 triggers one token refresh, then `Auth`.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as B64};
use base64::Engine;
use rand::{Rng, RngCore};
use reqwest::header::{HeaderMap, CONTENT_RANGE, CONTENT_TYPE, LOCATION, RANGE, RETRY_AFTER};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use super::provider::{
    validate_name, AccountInfo, Capabilities, ProviderAuth, ProviderError, RemoteObject, StorageProvider,
};

pub const PROVIDER_ID: &str = "gdrive";
pub const SCOPES: &str = "https://www.googleapis.com/auth/drive.appdata openid email";
/// Dev builds use their own keychain entry, like `ai.rs`, so they never touch the installed app's sign-in.
pub const KEYRING_SERVICE: &str = if crate::profile::IS_DEV { "notiq-vault-sync-dev" } else { "notiq-vault-sync" };
pub const KEYRING_ACCOUNT: &str = "gdrive-oauth";
pub const MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;
/// Objects at least this large go through a resumable upload session.
pub const RESUMABLE_THRESHOLD: usize = 5 * 1024 * 1024;
/// Resumable chunk size; Drive requires a multiple of 256 KiB.
pub const CHUNK_SIZE: usize = 8 * 256 * 1024;
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(180);
pub const NOT_CONFIGURED: &str = "Google sign-in isn't configured in this build of Notiq.";

const BUILD_CLIENT_ID: Option<&str> = option_env!("NOTIQ_GOOGLE_CLIENT_ID");
const BUILD_CLIENT_SECRET: Option<&str> = option_env!("NOTIQ_GOOGLE_CLIENT_SECRET");
const FILE_FIELDS: &str = "id,name,size,version,modifiedTime";
const APP_FOLDER_Q: &str = "'appDataFolder' in parents and trashed = false";
/// Refresh the access token this long before Google says it expires.
const TOKEN_SLACK: Duration = Duration::from_secs(60);

// ─── configuration ───────────────────────────────────────────────────────────

/// Google endpoints; overridable so tests can point at a local mock server.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub auth: String,
    pub token: String,
    pub revoke: String,
    pub files: String,
    pub upload: String,
}

impl Endpoints {
    pub fn google() -> Self {
        Self {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            files: "https://www.googleapis.com/drive/v3/files".into(),
            upload: "https://www.googleapis.com/upload/drive/v3/files".into(),
        }
    }

    /// Endpoints of a mock server at `base` (e.g. `http://127.0.0.1:1234`).
    pub fn at(base: &str) -> Self {
        Self {
            auth: format!("{base}/auth"),
            token: format!("{base}/token"),
            revoke: format!("{base}/revoke"),
            files: format!("{base}/files"),
            upload: format!("{base}/upload"),
        }
    }

    fn is_loopback(&self) -> bool {
        self.files.starts_with("http://127.0.0.1")
    }
}

/// The OAuth client of the Notiq Google Cloud project.
#[derive(Clone)]
pub struct OAuthClient {
    pub client_id: String,
    pub client_secret: String,
}

impl OAuthClient {
    /// The client baked in at build time, if any.
    pub fn from_build() -> Option<Self> {
        let id = BUILD_CLIENT_ID.filter(|s| !s.trim().is_empty())?;
        let secret = BUILD_CLIENT_SECRET.filter(|s| !s.trim().is_empty())?;
        Some(Self { client_id: id.trim().to_string(), client_secret: secret.trim().to_string() })
    }
}

/// Retry/backoff tuning.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Attempts per request (first try included).
    pub max_attempts: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
    /// A `Retry-After` longer than this is returned to the caller as `RateLimited` instead of waited out.
    pub max_retry_after_s: u64,
    /// Used for 429/403-rate-limit replies without a `Retry-After` header.
    pub default_retry_after_s: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self { max_attempts: 5, base_delay_ms: 500, max_delay_ms: 16_000, max_retry_after_s: 60, default_retry_after_s: 5 }
    }
}

/// Delay before retry number `attempt` (0-based): exponential with "equal jitter"
/// (`jitter01` in `[0, 1)`), capped at `max_delay_ms`. A server `Retry-After` wins.
pub fn backoff_delay(policy: &RetryPolicy, attempt: u32, retry_after_s: Option<u64>, jitter01: f64) -> Duration {
    if let Some(s) = retry_after_s {
        return Duration::from_secs(s);
    }
    let exp = policy.base_delay_ms.saturating_mul(1u64 << attempt.min(20)).min(policy.max_delay_ms);
    let half = exp / 2;
    Duration::from_millis(half + (half as f64 * jitter01.clamp(0.0, 1.0)) as u64)
}

/// Where the sign-in secret is kept.
pub trait SecretStore: Send + Sync {
    fn load(&self) -> Result<Option<String>, String>;
    fn save(&self, value: &str) -> Result<(), String>;
    fn clear(&self) -> Result<(), String>;
}

/// The OS keychain (Windows Credential Manager / macOS Keychain / Secret Service).
pub struct KeyringStore {
    service: String,
    account: String,
}

impl KeyringStore {
    pub fn new(service: &str, account: &str) -> Self {
        Self { service: service.into(), account: account.into() }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, &self.account).map_err(|e| e.to_string())
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
    }
}

impl SecretStore for KeyringStore {
    fn load(&self) -> Result<Option<String>, String> {
        match self.entry()?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn save(&self, value: &str) -> Result<(), String> {
        self.entry()?.set_password(value).map_err(|e| e.to_string())
    }

    fn clear(&self) -> Result<(), String> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// A process-local store (tests, or a session that must not persist).
#[derive(Default)]
pub struct MemorySecretStore(Mutex<Option<String>>);

impl SecretStore for MemorySecretStore {
    fn load(&self) -> Result<Option<String>, String> {
        Ok(self.0.lock().map_err(|_| "lock")?.clone())
    }
    fn save(&self, value: &str) -> Result<(), String> {
        *self.0.lock().map_err(|_| "lock")? = Some(value.to_string());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.0.lock().map_err(|_| "lock")? = None;
        Ok(())
    }
}

/// What the keychain entry holds (JSON).
#[derive(Serialize, Deserialize)]
struct StoredAuth {
    refresh_token: String,
    email: String,
}

/// Opens a URL in the user's browser (in the app: `tauri_plugin_opener`).
pub type UrlOpener = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Everything [`GoogleDriveProvider`] depends on.
pub struct DriveConfig {
    pub endpoints: Endpoints,
    /// `None` = this build has no Google client; `connect` and token refresh fail with [`NOT_CONFIGURED`].
    pub oauth: Option<OAuthClient>,
    pub store: Arc<dyn SecretStore>,
    pub opener: Option<UrlOpener>,
    pub retry: RetryPolicy,
    pub max_object_bytes: u64,
    pub resumable_threshold: usize,
    pub chunk_size: usize,
    pub login_timeout: Duration,
}

impl DriveConfig {
    /// Real Google endpoints, build-time client, OS keychain.
    pub fn production(opener: Option<UrlOpener>) -> Self {
        Self {
            endpoints: Endpoints::google(),
            oauth: OAuthClient::from_build(),
            store: Arc::new(KeyringStore::default()),
            opener,
            retry: RetryPolicy::default(),
            max_object_bytes: MAX_OBJECT_BYTES,
            resumable_threshold: RESUMABLE_THRESHOLD,
            chunk_size: CHUNK_SIZE,
            login_timeout: LOGIN_TIMEOUT,
        }
    }
}

// ─── pure helpers ────────────────────────────────────────────────────────────

fn random_b64(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    B64.encode(b)
}

/// PKCE S256 challenge for `verifier` (RFC 7636).
pub fn pkce_challenge(verifier: &str) -> String {
    B64.encode(Sha256::digest(verifier.as_bytes()))
}

/// The Google consent-page URL.
pub fn build_auth_url(auth_endpoint: &str, client_id: &str, redirect: &str, challenge: &str, state: &str) -> Result<String, ProviderError> {
    reqwest::Url::parse_with_params(
        auth_endpoint,
        &[
            ("client_id", client_id),
            ("redirect_uri", redirect),
            ("response_type", "code"),
            ("scope", SCOPES),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("access_type", "offline"),
            ("prompt", "consent"),
        ],
    )
    .map(|u| u.to_string())
    .map_err(|e| ProviderError::Other(format!("Bad sign-in URL: {e}")))
}

/// What arrived on the loopback redirect.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    Code(String),
    Cancelled(String),
    StateMismatch,
    /// Favicon, probes, anything without `code`/`error`.
    Ignore,
}

/// Interpret the request target (`/?code=…&state=…`) of a loopback request.
pub fn parse_callback(target: &str, want_state: &str) -> Callback {
    let Ok(u) = reqwest::Url::parse(&format!("http://127.0.0.1{target}")) else { return Callback::Ignore };
    let get = |k: &str| u.query_pairs().find(|(a, _)| a == k).map(|(_, b)| b.into_owned());
    if let Some(err) = get("error") {
        return Callback::Cancelled(err);
    }
    match (get("code"), get("state")) {
        (Some(code), Some(st)) if st == want_state && !code.is_empty() => Callback::Code(code),
        (Some(_), _) => Callback::StateMismatch,
        _ => Callback::Ignore,
    }
}

/// The account email from an OpenID `id_token` (display only; it came from Google over TLS).
pub fn email_from_id_token(t: &str) -> Option<String> {
    let payload = B64.decode(t.split('.').nth(1)?.trim_end_matches('=')).ok()?;
    serde_json::from_slice::<Value>(&payload).ok()?["email"].as_str().map(str::to_string)
}

/// A successful reply from the token endpoint.
#[derive(Debug)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: u64,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
}

/// Interpret a token-endpoint reply.
pub fn parse_token_response(status: u16, body: &str) -> Result<TokenResponse, ProviderError> {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if (200..300).contains(&status) {
        if let Some(at) = v["access_token"].as_str().filter(|s| !s.is_empty()) {
            return Ok(TokenResponse {
                access_token: at.to_string(),
                expires_in: v["expires_in"].as_u64().unwrap_or(3000),
                refresh_token: v["refresh_token"].as_str().map(str::to_string),
                id_token: v["id_token"].as_str().map(str::to_string),
            });
        }
        return Err(ProviderError::Other("Unexpected reply from Google sign-in".into()));
    }
    match v["error"].as_str() {
        Some("invalid_grant") => Err(ProviderError::Auth),
        Some("invalid_client") | Some("unauthorized_client") => {
            Err(ProviderError::Other("Google sign-in isn't configured correctly in this build of Notiq.".into()))
        }
        _ if status == 429 => Err(ProviderError::RateLimited { retry_after_s: 5 }),
        _ if status >= 500 => Err(ProviderError::Offline),
        _ => Err(ProviderError::Other(format!("Google sign-in failed ({status})"))),
    }
}

/// Escape a value for a Drive `q` string literal.
pub fn escape_q(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\'', "\\'")
}

/// The Drive query that finds the file(s) for one object name.
pub fn name_query(name: &str) -> String {
    format!("name = '{}' and {APP_FOLDER_Q}", escape_q(name))
}

/// One Drive file, as returned by `files.list` / uploads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DriveFile {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub version: u64,
    pub modified_ms: Option<i64>,
}

impl DriveFile {
    fn remote(&self) -> RemoteObject {
        RemoteObject {
            name: self.name.clone(),
            size: self.size,
            revision: format!("{}@{}", self.id, self.version),
            modified_ms: self.modified_ms,
        }
    }
}

/// Drive encodes int64 fields as strings; accept numbers too.
fn int_field(v: &Value) -> Option<u64> {
    v.as_u64().or_else(|| v.as_str()?.parse().ok())
}

pub fn parse_file(v: &Value) -> Option<DriveFile> {
    Some(DriveFile {
        id: v["id"].as_str()?.to_string(),
        name: v["name"].as_str()?.to_string(),
        size: int_field(&v["size"]).unwrap_or(0),
        version: int_field(&v["version"]).unwrap_or(0),
        modified_ms: v["modifiedTime"].as_str().and_then(parse_rfc3339_ms),
    })
}

/// A `files.list` page: the files and the next page token.
pub fn parse_file_list(body: &str) -> Result<(Vec<DriveFile>, Option<String>), ProviderError> {
    let v: Value = serde_json::from_str(body).map_err(|_| ProviderError::Other("Unexpected reply from Google Drive".into()))?;
    let files = v["files"].as_array().map(|a| a.iter().filter_map(parse_file).collect()).unwrap_or_default();
    let next = v["nextPageToken"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    Ok((files, next))
}

/// Split same-name files into (winner, losers): newest `modifiedTime`, then highest
/// `version`, then highest id — deterministic on every device.
pub fn pick_newest(mut files: Vec<DriveFile>) -> (Option<DriveFile>, Vec<DriveFile>) {
    files.sort_by(|a, b| {
        (b.modified_ms.unwrap_or(i64::MIN), b.version, &b.id).cmp(&(a.modified_ms.unwrap_or(i64::MIN), a.version, &a.id))
    });
    let mut it = files.into_iter();
    let first = it.next();
    (first, it.collect())
}

/// `2026-10-31T12:34:56.789Z` (or with a `±hh:mm` offset) → Unix ms.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?, num(17..19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &s[start..i];
        if frac.is_empty() {
            return None;
        }
        ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    }
    let offset_min = match &s[i..] {
        "Z" | "z" => 0,
        tz if tz.len() == 6 && matches!(tz.as_bytes()[0], b'+' | b'-') && tz.as_bytes()[3] == b':' => {
            let m = tz[1..3].parse::<i64>().ok()? * 60 + tz[4..6].parse::<i64>().ok()?;
            if tz.starts_with('-') { -m } else { m }
        }
        _ => return None,
    };
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + se) - offset_min * 60) * 1000 + ms)
}

/// `Retry-After: <seconds>` (HTTP-date form is ignored).
pub fn parse_retry_after(h: Option<&str>) -> Option<u64> {
    h?.trim().parse().ok()
}

/// End offset (inclusive) from a resumable `Range: bytes=0-N` header.
pub fn parse_range_end(h: Option<&str>) -> Option<u64> {
    h?.trim().strip_prefix("bytes=")?.split('-').nth(1)?.trim().parse().ok()
}

/// `multipart/related` body for a metadata + media upload.
pub fn multipart_body(boundary: &str, meta: &Value, data: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(data.len() + 256);
    body.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n")
            .as_bytes(),
    );
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// The `reason` of a Drive error body (`error.errors[0].reason`).
fn error_reason(v: &Value) -> Option<&str> {
    v["error"]["errors"][0]["reason"].as_str().or_else(|| v["error"]["status"].as_str())
}

fn error_message(v: &Value) -> String {
    let m = v["error"]["message"].as_str().unwrap_or("request failed");
    m.chars().take(200).collect()
}

/// A failed attempt, with what the retry loop needs to know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub err: ProviderError,
    pub retry: bool,
    pub retry_after: Option<u64>,
    pub unauthorized: bool,
}

impl Failure {
    fn of(err: ProviderError) -> Self {
        let retry = err.is_retryable();
        let retry_after = match err {
            ProviderError::RateLimited { retry_after_s } => Some(retry_after_s),
            _ => None,
        };
        Self { err, retry, retry_after, unauthorized: false }
    }
}

/// Map a non-success Drive HTTP reply onto a [`Failure`].
pub fn classify_status(status: u16, retry_after: Option<u64>, body: &str, policy: &RetryPolicy) -> Failure {
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let rate = |ra: Option<u64>| {
        let s = ra.unwrap_or(policy.default_retry_after_s);
        Failure { err: ProviderError::RateLimited { retry_after_s: s }, retry: true, retry_after: Some(s), unauthorized: false }
    };
    let plain = |err: ProviderError, retry: bool| Failure { err, retry, retry_after: None, unauthorized: false };
    match status {
        401 => Failure { unauthorized: true, ..plain(ProviderError::Auth, false) },
        404 | 410 => plain(ProviderError::NotFound, false),
        408 => plain(ProviderError::Offline, true),
        413 => plain(ProviderError::TooLarge, false),
        429 => rate(retry_after),
        403 => match error_reason(&v) {
            Some("rateLimitExceeded" | "userRateLimitExceeded" | "sharingRateLimitExceeded" | "RESOURCE_EXHAUSTED") => rate(retry_after),
            Some("dailyLimitExceeded") => rate(Some(retry_after.unwrap_or(3600))),
            Some("storageQuotaExceeded") => plain(ProviderError::Other("Your Google Drive storage is full.".into()), false),
            Some("insufficientPermissions" | "authError" | "insufficientScopes" | "PERMISSION_DENIED") => plain(ProviderError::Auth, false),
            _ => plain(ProviderError::Other(format!("Google Drive refused the request: {}", error_message(&v))), false),
        },
        500..=599 => plain(ProviderError::Other(format!("Google Drive is having trouble ({status}). Try again later.")), true),
        _ => plain(ProviderError::Other(format!("Google Drive error {status}: {}", error_message(&v))), false),
    }
}

/// Network-level failure (no HTTP reply). Never includes the URL (it may carry an upload session id).
fn net_failure(e: reqwest::Error) -> Failure {
    if e.is_builder() {
        Failure::of(ProviderError::Other(e.without_url().to_string()))
    } else {
        Failure::of(ProviderError::Offline)
    }
}

fn header(h: &HeaderMap, name: reqwest::header::HeaderName) -> Option<&str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

fn is_success(s: u16) -> bool {
    (200..300).contains(&s)
}

fn success_or_resume(s: u16) -> bool {
    is_success(s) || s == 308
}

/// The page the browser lands on after Google redirects to the loopback port.
pub fn callback_page(ok: bool, heading: &str, text: &str) -> String {
    let icon = STANDARD.encode(include_bytes!("../callback-icon.png"));
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

/// Serve loopback requests until the OAuth redirect arrives.
async fn wait_for_code(listener: &TcpListener, want_state: &str) -> Result<String, ProviderError> {
    loop {
        let (mut s, _) = listener
            .accept()
            .await
            .map_err(|e| ProviderError::Other(format!("Sign-in listener failed: {e}")))?;
        let mut buf = vec![0u8; 8192];
        let mut n = 0;
        let read = tokio::time::timeout(Duration::from_secs(5), async {
            while n < buf.len() {
                let k = s.read(&mut buf[n..]).await?;
                if k == 0 {
                    break;
                }
                n += k;
                if buf[..n].windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Ok::<_, std::io::Error>(())
        })
        .await;
        if !matches!(read, Ok(Ok(()))) {
            continue;
        }
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("/").to_string();
        let outcome = parse_callback(&target, want_state);
        let (ok, heading, text) = match &outcome {
            Callback::Code(_) => (
                true,
                "Notiq is connected to Google Drive",
                "Your encrypted vault syncs to Notiq's private app folder. Notiq can't see any other file in your Drive.",
            ),
            Callback::Cancelled(_) => (false, "Sign-in was cancelled", "Nothing was connected. You can try again from Notiq."),
            Callback::StateMismatch => (
                false,
                "Sign-in didn't match",
                "This response wasn't for the sign-in Notiq started. Try again from the app.",
            ),
            Callback::Ignore => (false, "Waiting for sign-in", "Finish signing in with Google, then return here."),
        };
        let html = callback_page(ok, heading, text);
        let _ = s
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{html}",
                    html.len()
                )
                .as_bytes(),
            )
            .await;
        let _ = s.shutdown().await;
        match outcome {
            Callback::Code(c) => return Ok(c),
            Callback::Cancelled(e) => return Err(ProviderError::Other(format!("Google sign-in was cancelled ({e})."))),
            Callback::StateMismatch => return Err(ProviderError::Other("Sign-in response didn't match this request. Try again.".into())),
            Callback::Ignore => continue,
        }
    }
}

// ─── provider ────────────────────────────────────────────────────────────────

/// Google Drive (`appDataFolder`) storage.
pub struct GoogleDriveProvider {
    cfg: DriveConfig,
    http: reqwest::Client,
    /// Access token + expiry, memory only. The async mutex also serialises refreshes.
    access: tokio::sync::Mutex<Option<(String, Instant)>>,
}

impl GoogleDriveProvider {
    pub fn new(cfg: DriveConfig) -> Result<Self, ProviderError> {
        let mut b = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            // Resumable uploads answer 308 without a Location; never follow it.
            .redirect(reqwest::redirect::Policy::none());
        if cfg.endpoints.is_loopback() {
            b = b.no_proxy();
        }
        let http = b.build().map_err(|e| ProviderError::Other(e.to_string()))?;
        Ok(Self { cfg, http, access: tokio::sync::Mutex::new(None) })
    }

    /// Production provider (real Google, build-time client, OS keychain).
    pub fn production(opener: Option<UrlOpener>) -> Result<Self, ProviderError> {
        Self::new(DriveConfig::production(opener))
    }

    /// Whether this build can sign in at all.
    pub fn is_configured(&self) -> bool {
        self.cfg.oauth.is_some()
    }

    fn oauth(&self) -> Result<&OAuthClient, ProviderError> {
        self.cfg.oauth.as_ref().ok_or_else(|| ProviderError::Other(NOT_CONFIGURED.into()))
    }

    fn stored(&self) -> Result<Option<StoredAuth>, ProviderError> {
        let raw = self.cfg.store.load().map_err(|e| ProviderError::Other(format!("Couldn't read the system keychain: {e}")))?;
        Ok(raw.and_then(|r| serde_json::from_str(&r).ok()))
    }

    /// A valid access token; refreshed when (nearly) expired or when `force`.
    async fn token(&self, force: bool) -> Result<String, ProviderError> {
        let mut cache = self.access.lock().await;
        if !force {
            if let Some((t, exp)) = cache.as_ref() {
                if *exp > Instant::now() + TOKEN_SLACK {
                    return Ok(t.clone());
                }
            }
        }
        let oauth = self.oauth()?;
        let stored = self.stored()?.ok_or(ProviderError::Auth)?;
        let resp = self
            .http
            .post(&self.cfg.endpoints.token)
            .form(&[
                ("client_id", oauth.client_id.as_str()),
                ("client_secret", oauth.client_secret.as_str()),
                ("refresh_token", stored.refresh_token.as_str()),
                ("grant_type", "refresh_token"),
            ])
            .send()
            .await
            .map_err(|e| net_failure(e).err)?;
        let status = resp.status().as_u16();
        let body = resp.text().await.map_err(|e| net_failure(e).err)?;
        let tok = parse_token_response(status, &body)?;
        *cache = Some((tok.access_token.clone(), Instant::now() + Duration::from_secs(tok.expires_in)));
        Ok(tok.access_token)
    }

    /// One HTTP attempt with a bearer token; statuses outside `accept` become a [`Failure`].
    async fn send_once<F>(&self, build: &F, accept: fn(u16) -> bool, force_refresh: bool) -> Result<reqwest::Response, Failure>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let token = self.token(force_refresh).await.map_err(Failure::of)?;
        let resp = build(&self.http, &token).send().await.map_err(net_failure)?;
        let status = resp.status().as_u16();
        if accept(status) {
            return Ok(resp);
        }
        let ra = parse_retry_after(header(resp.headers(), RETRY_AFTER));
        let body = resp.text().await.unwrap_or_default();
        Err(classify_status(status, ra, &body, &self.cfg.retry))
    }

    async fn pause(&self, attempt: u32, retry_after: Option<u64>) {
        let jitter = rand::thread_rng().gen::<f64>();
        tokio::time::sleep(backoff_delay(&self.cfg.retry, attempt, retry_after, jitter)).await;
    }

    /// Decide whether a failure is retried; `Err` = give up with this error.
    fn should_retry(&self, f: &Failure, attempt: u32) -> Result<(), ProviderError> {
        if !f.retry || attempt >= self.cfg.retry.max_attempts {
            return Err(f.err.clone());
        }
        if f.retry_after.is_some_and(|s| s > self.cfg.retry.max_retry_after_s) {
            return Err(f.err.clone());
        }
        Ok(())
    }

    /// Send with retry/backoff and one forced token refresh on 401.
    async fn execute<F>(&self, build: F, accept: fn(u16) -> bool) -> Result<reqwest::Response, ProviderError>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let (mut attempt, mut refreshed, mut force) = (0u32, false, false);
        loop {
            match self.send_once(&build, accept, std::mem::take(&mut force)).await {
                Ok(r) => return Ok(r),
                Err(f) if f.unauthorized && !refreshed => {
                    refreshed = true;
                    force = true;
                }
                Err(f) => {
                    attempt += 1;
                    self.should_retry(&f, attempt)?;
                    self.pause(attempt - 1, f.retry_after).await;
                }
            }
        }
    }

    async fn body_text(resp: reqwest::Response) -> Result<String, ProviderError> {
        resp.text().await.map_err(|e| net_failure(e).err)
    }

    async fn body_file(resp: reqwest::Response) -> Result<DriveFile, ProviderError> {
        let text = Self::body_text(resp).await?;
        serde_json::from_str::<Value>(&text)
            .ok()
            .as_ref()
            .and_then(parse_file)
            .ok_or_else(|| ProviderError::Other("Unexpected reply from Google Drive".into()))
    }

    /// Every file in the app folder matching `q` (all pages).
    async fn list_files(&self, q: &str) -> Result<Vec<DriveFile>, ProviderError> {
        let fields = format!("nextPageToken,files({FILE_FIELDS})");
        let mut out = Vec::new();
        let mut page: Option<String> = None;
        for _ in 0..10_000 {
            let resp = self
                .execute(
                    |c, t| {
                        let mut query = vec![("spaces", "appDataFolder"), ("q", q), ("fields", fields.as_str()), ("pageSize", "1000")];
                        if let Some(p) = page.as_deref() {
                            query.push(("pageToken", p));
                        }
                        c.get(&self.cfg.endpoints.files).query(&query).bearer_auth(t)
                    },
                    is_success,
                )
                .await?;
            let (files, next) = parse_file_list(&Self::body_text(resp).await?)?;
            out.extend(files);
            match next {
                Some(n) => page = Some(n),
                None => return Ok(out),
            }
        }
        Err(ProviderError::Other("Google Drive returned too many pages".into()))
    }

    async fn find(&self, name: &str) -> Result<(Option<DriveFile>, Vec<DriveFile>), ProviderError> {
        let files = self.list_files(&name_query(name)).await?;
        Ok(pick_newest(files.into_iter().filter(|f| f.name == name).collect()))
    }

    async fn delete_id(&self, id: &str) -> Result<(), ProviderError> {
        let url = format!("{}/{id}", self.cfg.endpoints.files);
        match self.execute(|c, t| c.delete(&url).bearer_auth(t), is_success).await {
            Ok(_) | Err(ProviderError::NotFound) => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn upload_multipart(&self, existing: Option<&str>, name: &str, data: &[u8]) -> Result<DriveFile, ProviderError> {
        let boundary = format!("notiq{}", random_b64(12).replace(['-', '_'], "x"));
        let meta = match existing {
            Some(_) => json!({}),
            None => json!({ "name": name, "parents": ["appDataFolder"] }),
        };
        let body = multipart_body(&boundary, &meta, data);
        let ctype = format!("multipart/related; boundary={boundary}");
        let query = [("uploadType", "multipart"), ("fields", FILE_FIELDS)];
        let resp = match existing {
            Some(id) => {
                let url = format!("{}/{id}", self.cfg.endpoints.upload);
                self.execute(|c, t| c.patch(&url).query(&query).bearer_auth(t).header(CONTENT_TYPE, &ctype).body(body.clone()), is_success)
                    .await?
            }
            None => {
                let url = &self.cfg.endpoints.upload;
                self.execute(|c, t| c.post(url).query(&query).bearer_auth(t).header(CONTENT_TYPE, &ctype).body(body.clone()), is_success)
                    .await?
            }
        };
        Self::body_file(resp).await
    }

    /// Open a resumable session; returns the session URI.
    async fn start_resumable(&self, existing: Option<&str>, name: &str, len: usize) -> Result<String, ProviderError> {
        let meta = match existing {
            Some(_) => json!({}),
            None => json!({ "name": name, "parents": ["appDataFolder"] }),
        }
        .to_string();
        let query = [("uploadType", "resumable"), ("fields", FILE_FIELDS)];
        let url = match existing {
            Some(id) => format!("{}/{id}", self.cfg.endpoints.upload),
            None => self.cfg.endpoints.upload.clone(),
        };
        let resp = self
            .execute(
                |c, t| {
                    let rb = if existing.is_some() { c.patch(&url) } else { c.post(&url) };
                    rb.query(&query)
                        .bearer_auth(t)
                        .header(CONTENT_TYPE, "application/json; charset=UTF-8")
                        .header("X-Upload-Content-Type", "application/octet-stream")
                        .header("X-Upload-Content-Length", len.to_string())
                        .body(meta.clone())
                },
                is_success,
            )
            .await?;
        header(resp.headers(), LOCATION)
            .map(str::to_string)
            .ok_or_else(|| ProviderError::Other("Google Drive didn't start the upload".into()))
    }

    /// Chunked resumable upload. A session that expires (404/410) is restarted once;
    /// transient failures ask the server how much it has and continue from there.
    async fn upload_resumable(&self, existing: Option<&str>, name: &str, data: &[u8]) -> Result<DriveFile, ProviderError> {
        let len = data.len() as u64;
        let chunk = self.cfg.chunk_size.max(256 * 1024) as u64;
        let mut restarts = 0;
        'session: loop {
            let session = self.start_resumable(existing, name, data.len()).await?;
            let (mut offset, mut failures, mut force) = (0u64, 0u32, false);
            loop {
                let step: Result<reqwest::Response, Failure> = if offset < len {
                    let end = (offset + chunk).min(len);
                    let range = format!("bytes {offset}-{}/{len}", end - 1);
                    let part = &data[offset as usize..end as usize];
                    let build = |c: &reqwest::Client, t: &str| c.put(&session).bearer_auth(t).header(CONTENT_RANGE, &range).body(part.to_vec());
                    self.send_once(&build, success_or_resume, std::mem::take(&mut force)).await
                } else {
                    // Everything was sent but not confirmed: ask for the status.
                    let range = format!("bytes */{len}");
                    let build = |c: &reqwest::Client, t: &str| c.put(&session).bearer_auth(t).header(CONTENT_RANGE, &range).body(Vec::new());
                    self.send_once(&build, success_or_resume, std::mem::take(&mut force)).await
                };
                match step {
                    Ok(resp) if resp.status().as_u16() == 308 => {
                        let next = parse_range_end(header(resp.headers(), RANGE)).map_or(0, |e| e + 1);
                        if next > len {
                            return Err(ProviderError::Other("Unexpected reply from Google Drive".into()));
                        }
                        if offset >= len && next == len {
                            return Err(ProviderError::Other("Google Drive didn't finish the upload".into()));
                        }
                        if next <= offset && offset < len {
                            failures += 1; // no progress
                            if failures >= self.cfg.retry.max_attempts {
                                return Err(ProviderError::Other("Upload to Google Drive stalled".into()));
                            }
                        } else {
                            failures = 0;
                        }
                        offset = next;
                    }
                    Ok(resp) => return Self::body_file(resp).await,
                    Err(f) if f.err == ProviderError::NotFound && restarts == 0 => {
                        restarts += 1;
                        continue 'session;
                    }
                    Err(f) if f.unauthorized => {
                        failures += 1;
                        if failures >= self.cfg.retry.max_attempts {
                            return Err(ProviderError::Auth);
                        }
                        force = true;
                    }
                    Err(f) => {
                        failures += 1;
                        self.should_retry(&f, failures)?;
                        self.pause(failures - 1, f.retry_after).await;
                        // Resume from what the server actually stored.
                        let range = format!("bytes */{len}");
                        let build = |c: &reqwest::Client, t: &str| c.put(&session).bearer_auth(t).header(CONTENT_RANGE, &range).body(Vec::new());
                        match self.send_once(&build, success_or_resume, false).await {
                            Ok(r) if r.status().as_u16() == 308 => offset = parse_range_end(header(r.headers(), RANGE)).map_or(0, |e| e + 1),
                            Ok(r) => return Self::body_file(r).await,
                            Err(q) if q.err == ProviderError::NotFound && restarts == 0 => {
                                restarts += 1;
                                continue 'session;
                            }
                            Err(_) => {} // retry the same chunk; the server answers 308 if it disagrees
                        }
                    }
                }
            }
        }
    }
}

#[async_trait]
impl StorageProvider for GoogleDriveProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities { overwrite: true, delete: true, max_object_bytes: self.cfg.max_object_bytes }
    }

    async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, ProviderError> {
        let mut by_name: std::collections::BTreeMap<String, Vec<DriveFile>> = Default::default();
        for f in self.list_files(APP_FOLDER_Q).await? {
            if f.name.starts_with(prefix) && validate_name(&f.name).is_ok() {
                by_name.entry(f.name.clone()).or_default().push(f);
            }
        }
        Ok(by_name.into_values().filter_map(|v| pick_newest(v).0.map(|f| f.remote())).collect())
    }

    async fn get(&self, name: &str) -> Result<Vec<u8>, ProviderError> {
        validate_name(name)?;
        let file = self.find(name).await?.0.ok_or(ProviderError::NotFound)?;
        if file.size > self.cfg.max_object_bytes {
            return Err(ProviderError::TooLarge);
        }
        let url = format!("{}/{}", self.cfg.endpoints.files, file.id);
        let resp = self.execute(|c, t| c.get(&url).query(&[("alt", "media")]).bearer_auth(t), is_success).await?;
        let bytes = resp.bytes().await.map_err(|e| net_failure(e).err)?;
        if bytes.len() as u64 > self.cfg.max_object_bytes {
            return Err(ProviderError::TooLarge);
        }
        Ok(bytes.to_vec())
    }

    async fn put(&self, name: &str, data: &[u8]) -> Result<RemoteObject, ProviderError> {
        validate_name(name)?;
        if data.len() as u64 > self.cfg.max_object_bytes {
            return Err(ProviderError::TooLarge);
        }
        let (current, duplicates) = self.find(name).await?;
        let existing = current.as_ref().map(|f| f.id.as_str());
        let file = if data.len() >= self.cfg.resumable_threshold {
            self.upload_resumable(existing, name, data).await?
        } else {
            self.upload_multipart(existing, name, data).await?
        };
        for dup in duplicates {
            let _ = self.delete_id(&dup.id).await; // best effort; `list`/`get` already pick the newest
        }
        Ok(file.remote())
    }

    async fn delete(&self, name: &str) -> Result<(), ProviderError> {
        validate_name(name)?;
        let (current, duplicates) = self.find(name).await?;
        let current = current.ok_or(ProviderError::NotFound)?;
        for f in std::iter::once(current).chain(duplicates) {
            self.delete_id(&f.id).await?;
        }
        Ok(())
    }
}

#[async_trait]
impl ProviderAuth for GoogleDriveProvider {
    async fn connect(&self) -> Result<AccountInfo, ProviderError> {
        let oauth = self.oauth()?.clone();
        let opener = self.cfg.opener.clone().ok_or_else(|| ProviderError::Other("Can't open a browser for Google sign-in".into()))?;
        let verifier = random_b64(48);
        let state = random_b64(16);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| ProviderError::Other(format!("Couldn't start Google sign-in: {e}")))?;
        let port = listener.local_addr().map_err(|e| ProviderError::Other(e.to_string()))?.port();
        let redirect = format!("http://127.0.0.1:{port}");
        let url = build_auth_url(&self.cfg.endpoints.auth, &oauth.client_id, &redirect, &pkce_challenge(&verifier), &state)?;
        opener(&url).map_err(|e| ProviderError::Other(format!("Couldn't open the browser: {e}")))?;
        let code = tokio::time::timeout(self.cfg.login_timeout, wait_for_code(&listener, &state))
            .await
            .map_err(|_| ProviderError::Other("Google sign-in timed out. Try again.".into()))??;
        drop(listener);

        let resp = self
            .http
            .post(&self.cfg.endpoints.token)
            .form(&[
                ("client_id", oauth.client_id.as_str()),
                ("client_secret", oauth.client_secret.as_str()),
                ("code", code.as_str()),
                ("redirect_uri", redirect.as_str()),
                ("grant_type", "authorization_code"),
                ("code_verifier", verifier.as_str()),
            ])
            .send()
            .await
            .map_err(|e| net_failure(e).err)?;
        let status = resp.status().as_u16();
        let body = Self::body_text(resp).await?;
        let tok = match parse_token_response(status, &body) {
            Err(ProviderError::Auth) => return Err(ProviderError::Other("Google rejected the sign-in. Try again.".into())),
            other => other?,
        };
        let refresh = tok.refresh_token.clone().ok_or_else(|| {
            ProviderError::Other("Google didn't grant offline access. Remove Notiq from your Google account's third-party access and try again.".into())
        })?;
        let email = tok.id_token.as_deref().and_then(email_from_id_token).unwrap_or_else(|| "Google account".into());
        let stored = serde_json::to_string(&StoredAuth { refresh_token: refresh, email: email.clone() })
            .map_err(|e| ProviderError::Other(e.to_string()))?;
        self.cfg
            .store
            .save(&stored)
            .map_err(|e| ProviderError::Other(format!("Couldn't save the sign-in to the system keychain: {e}")))?;
        *self.access.lock().await = Some((tok.access_token, Instant::now() + Duration::from_secs(tok.expires_in)));
        Ok(AccountInfo { label: email })
    }

    async fn disconnect(&self) -> Result<(), ProviderError> {
        if let Ok(Some(stored)) = self.stored() {
            // Best effort: the token is forgotten locally either way.
            let _ = self
                .http
                .post(&self.cfg.endpoints.revoke)
                .timeout(Duration::from_secs(10))
                .form(&[("token", stored.refresh_token.as_str())])
                .send()
                .await;
        }
        *self.access.lock().await = None;
        self.cfg
            .store
            .clear()
            .map_err(|e| ProviderError::Other(format!("Couldn't remove the sign-in from the system keychain: {e}")))
    }

    fn account(&self) -> Option<AccountInfo> {
        self.stored().ok().flatten().map(|s| AccountInfo { label: s.email })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> RetryPolicy {
        RetryPolicy::default()
    }

    #[test]
    fn pkce_matches_rfc7636_vector() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let (a, b) = (random_b64(48), random_b64(48));
        assert_ne!(a, b);
        assert!(a.len() >= 43 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    #[test]
    fn auth_url_carries_pkce_state_and_scopes() {
        let u = build_auth_url("https://accounts.google.com/o/oauth2/v2/auth", "cid", "http://127.0.0.1:5555", "chal", "st").unwrap();
        let u = reqwest::Url::parse(&u).unwrap();
        let q: std::collections::HashMap<_, _> = u.query_pairs().into_owned().collect();
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert_eq!(q["scope"], SCOPES);
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["response_type"], "code");
    }

    #[test]
    fn callback_parsing() {
        assert_eq!(parse_callback("/?state=s1&code=4%2Fabc", "s1"), Callback::Code("4/abc".into()));
        assert_eq!(parse_callback("/?state=other&code=x", "s1"), Callback::StateMismatch);
        assert_eq!(parse_callback("/?code=x", "s1"), Callback::StateMismatch);
        assert_eq!(parse_callback("/?error=access_denied&state=s1", "s1"), Callback::Cancelled("access_denied".into()));
        assert_eq!(parse_callback("/favicon.ico", "s1"), Callback::Ignore);
    }

    #[test]
    fn email_is_read_from_an_id_token_payload() {
        let payload = B64.encode(br#"{"email":"a@b.co","sub":"1"}"#);
        assert_eq!(email_from_id_token(&format!("h.{payload}.s")).as_deref(), Some("a@b.co"));
        assert_eq!(email_from_id_token("garbage"), None);
    }

    #[test]
    fn token_responses() {
        let ok = parse_token_response(200, r#"{"access_token":"at","expires_in":3599,"refresh_token":"rt","id_token":"x"}"#).unwrap();
        assert_eq!((ok.access_token.as_str(), ok.expires_in, ok.refresh_token.as_deref()), ("at", 3599, Some("rt")));
        assert_eq!(parse_token_response(400, r#"{"error":"invalid_grant"}"#).unwrap_err(), ProviderError::Auth);
        assert!(matches!(parse_token_response(401, r#"{"error":"invalid_client"}"#), Err(ProviderError::Other(_))));
        assert_eq!(parse_token_response(503, "").unwrap_err(), ProviderError::Offline);
        assert!(matches!(parse_token_response(429, ""), Err(ProviderError::RateLimited { .. })));
        assert!(matches!(parse_token_response(200, "{}"), Err(ProviderError::Other(_))));
    }

    #[test]
    fn query_escaping_and_name_mapping() {
        assert_eq!(escape_q(r"a'b\c"), r"a\'b\\c");
        assert_eq!(name_query("devices/x.nqs"), "name = 'devices/x.nqs' and 'appDataFolder' in parents and trashed = false");
    }

    #[test]
    fn file_list_parsing() {
        let body = r#"{"nextPageToken":"p2","files":[
            {"id":"1","name":"devices/a.nqs","size":"12","version":"7","modifiedTime":"2026-10-31T00:00:01.500Z"},
            {"id":"2","name":"b","size":3,"version":2},
            {"name":"no-id"}]}"#;
        let (files, next) = parse_file_list(body).unwrap();
        assert_eq!(next.as_deref(), Some("p2"));
        assert_eq!(files.len(), 2);
        assert_eq!(files[0], DriveFile { id: "1".into(), name: "devices/a.nqs".into(), size: 12, version: 7, modified_ms: parse_rfc3339_ms("2026-10-31T00:00:01.500Z") });
        assert_eq!(files[0].remote().revision, "1@7");
        assert_eq!((files[1].size, files[1].version, files[1].modified_ms), (3, 2, None));
        assert_eq!(parse_file_list(r#"{"files":[]}"#).unwrap().1, None);
        assert!(parse_file_list("not json").is_err());
    }

    #[test]
    fn rfc3339_parsing() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        assert_eq!(parse_rfc3339_ms("2000-03-01T00:00:00.000Z"), Some(951_868_800_000));
        assert_eq!(parse_rfc3339_ms("2026-10-31T12:00:00+05:30"), parse_rfc3339_ms("2026-10-31T06:30:00Z"));
        assert_eq!(parse_rfc3339_ms("2024-02-29T23:59:59.999Z"), Some(1_709_251_199_999));
        for bad in ["", "2026-10-31", "2026-13-01T00:00:00Z", "2026-10-31T00:00:00", "2026-10-31T00:00:00.Z"] {
            assert_eq!(parse_rfc3339_ms(bad), None, "{bad}");
        }
    }

    #[test]
    fn duplicates_resolve_newest_first_deterministically() {
        let f = |id: &str, ms: Option<i64>, v: u64| DriveFile { id: id.into(), name: "n".into(), size: 0, version: v, modified_ms: ms };
        let (w, l) = pick_newest(vec![f("a", Some(1), 1), f("b", Some(3), 1), f("c", Some(2), 9)]);
        assert_eq!(w.unwrap().id, "b");
        assert_eq!(l.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["c", "a"]);
        let (w, _) = pick_newest(vec![f("a", Some(5), 1), f("z", Some(5), 1), f("m", Some(5), 1)]);
        assert_eq!(w.unwrap().id, "z", "tie broken by id");
        assert_eq!(pick_newest(vec![]).0, None);
    }

    #[test]
    fn header_helpers() {
        assert_eq!(parse_retry_after(Some("12")), Some(12));
        assert_eq!(parse_retry_after(Some("Wed, 21 Oct 2015 07:28:00 GMT")), None);
        assert_eq!(parse_retry_after(None), None);
        assert_eq!(parse_range_end(Some("bytes=0-524287")), Some(524_287));
        assert_eq!(parse_range_end(Some("garbage")), None);
        assert_eq!(parse_range_end(None), None);
    }

    #[test]
    fn multipart_layout() {
        let body = multipart_body("BB", &json!({"name":"x"}), b"\x00\x01");
        let text = String::from_utf8_lossy(&body);
        assert!(text.starts_with("--BB\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{\"name\":\"x\"}\r\n--BB\r\n"));
        assert!(body.ends_with(b"\r\n\x00\x01\r\n--BB--\r\n"));
    }

    #[test]
    fn status_classification() {
        let p = policy();
        let c = |s: u16, ra: Option<u64>, body: &str| classify_status(s, ra, body, &p);
        let reason = |r: &str| format!(r#"{{"error":{{"code":403,"message":"m","errors":[{{"reason":"{r}"}}]}}}}"#);
        assert!(c(401, None, "").unauthorized);
        assert_eq!(c(404, None, "").err, ProviderError::NotFound);
        assert_eq!(c(413, None, "").err, ProviderError::TooLarge);
        assert_eq!(c(429, Some(7), "").err, ProviderError::RateLimited { retry_after_s: 7 });
        assert_eq!(c(429, None, "").retry_after, Some(p.default_retry_after_s));
        assert!(c(429, None, "").retry);
        assert_eq!(c(403, Some(2), &reason("userRateLimitExceeded")).err, ProviderError::RateLimited { retry_after_s: 2 });
        assert!(c(403, None, &reason("rateLimitExceeded")).retry);
        assert_eq!(c(403, None, &reason("dailyLimitExceeded")).retry_after, Some(3600));
        assert_eq!(c(403, None, &reason("insufficientPermissions")).err, ProviderError::Auth);
        let full = c(403, None, &reason("storageQuotaExceeded"));
        assert!(matches!(full.err, ProviderError::Other(ref m) if m.contains("full")) && !full.retry);
        let s5 = c(503, None, "");
        assert!(s5.retry && matches!(s5.err, ProviderError::Other(_)));
        assert!(!c(400, None, "").retry);
        assert_eq!(c(408, None, "").err, ProviderError::Offline);
    }

    #[test]
    fn backoff_schedule() {
        let p = policy();
        let d = |a: u32, j: f64| backoff_delay(&p, a, None, j).as_millis() as u64;
        assert_eq!((d(0, 0.0), d(0, 0.999_999)), (250, 499));
        assert_eq!(d(1, 0.0), 500);
        assert_eq!(d(3, 0.0), 2000);
        assert_eq!(d(30, 0.0), p.max_delay_ms / 2, "capped");
        assert!(d(30, 0.999) < p.max_delay_ms);
        for a in 0..10 {
            assert!(d(a, 0.0) <= d(a + 1, 0.0), "non-decreasing");
        }
        assert_eq!(backoff_delay(&p, 4, Some(3), 0.5), Duration::from_secs(3), "Retry-After wins");
    }

    #[test]
    fn callback_page_is_self_contained_html() {
        let p = callback_page(true, "Connected", "ok");
        assert!(p.contains("<h1>Connected</h1>") && p.contains("data:image/png;base64,"));
        assert!(!p.contains("http://") && !p.contains("https://"));
    }

    #[test]
    fn keyring_names_follow_the_app_convention() {
        assert!(KEYRING_SERVICE.starts_with("notiq-vault-sync"));
        assert_eq!(KEYRING_ACCOUNT, "gdrive-oauth");
        assert_eq!(CHUNK_SIZE % (256 * 1024), 0);
    }

    #[test]
    fn unconfigured_build_cannot_connect() {
        let mut cfg = DriveConfig::production(None);
        cfg.oauth = None;
        cfg.store = Arc::new(MemorySecretStore::default());
        let p = GoogleDriveProvider::new(cfg).unwrap();
        assert!(!p.is_configured());
        let err = crate::sync::contract_tests::block_on(p.connect()).unwrap_err();
        assert_eq!(err, ProviderError::Other(NOT_CONFIGURED.into()));
        assert_eq!(p.account(), None);
    }

    /// Live contract run against a real Google Drive account. Ignored by default.
    ///
    /// ```text
    /// NOTIQ_GDRIVE_TEST_CLIENT_ID=…  NOTIQ_GDRIVE_TEST_CLIENT_SECRET=…  NOTIQ_GDRIVE_TEST_REFRESH_TOKEN=…
    /// cargo test --lib drive_contract_live -- --ignored --nocapture
    /// ```
    /// The refresh token must have the `drive.appdata` scope for that client. Only
    /// names under a random `contract-test-…/` prefix are touched and removed.
    #[test]
    #[ignore = "needs a real Google account; see doc comment for env vars"]
    fn drive_contract_live() {
        let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("set {k}"));
        let store = Arc::new(MemorySecretStore::default());
        store
            .save(&serde_json::to_string(&StoredAuth { refresh_token: var("NOTIQ_GDRIVE_TEST_REFRESH_TOKEN"), email: "live-test".into() }).unwrap())
            .unwrap();
        let mut cfg = DriveConfig::production(None);
        cfg.oauth = Some(OAuthClient { client_id: var("NOTIQ_GDRIVE_TEST_CLIENT_ID"), client_secret: var("NOTIQ_GDRIVE_TEST_CLIENT_SECRET") });
        cfg.store = store;
        let p = GoogleDriveProvider::new(cfg).unwrap();
        let ns = format!("contract-test-{}/", random_b64(6).replace(['-', '_'], "x"));
        crate::sync::contract_tests::block_on(crate::sync::contract_tests::run_contract(&p, &ns));
    }
}
