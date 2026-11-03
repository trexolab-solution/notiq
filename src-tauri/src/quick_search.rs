//! Quick search (0.7.0): an opt-in system-wide hotkey that pops up a small, always-on-top
//! search window over the vault (label `quick-search`, same frontend bundle routed by
//! `#/quick-search`).
//!
//! * The enabled flag + key combo live in `<app-data>/quick_search.json` (the Rust side can't
//!   read the WebView's localStorage), written through `quick_search_set`.
//! * The shortcut is (re)registered immediately on change and at startup. A failed registration
//!   (combo taken by another app) is reported back to the UI instead of failing silently.
//! * The window never shows secrets: `quick_search_index` returns names, kinds, tags and hosts
//!   only. Copying reads the one entry on demand through the normal vault commands.
//! * After a copy the window hides and the previously active window gets the focus back.
//! * 2-step codes (TOTP): the index only says *whether* a login has a 2FA secret (`totp: bool`).
//!   `quick_search_totp` returns the current 6-digit code and its seconds left for one entry; the
//!   secret itself never reaches the quick window. Only answered for the quick window, only while
//!   the vault is unlocked.
//! * Window lifecycle (0.9.3): a show waits (hidden, dark background) until the page reports ready
//!   (`quick_search_ready`), up to `READY_WAIT_MS`; focus loss hides it from Rust (`on_window_event`),
//!   so an outside click closes it even while the page is loading or dead; a page that was ready
//!   but doesn't answer a show is reloaded. Every hide goes through `hide_quick`.
//! * Window lifecycle (0.9.4): the window goes on screen only from `show_window`, i.e. the hotkey or
//!   a `quick_search_reopen` right after the popup's own "Unlock". `OPEN` records that intent; a
//!   guard thread (Windows) hides the window whenever it is visible without it, and closes an open
//!   window once another window holds the foreground (on Windows, Tauri's `Focused(false)` only comes
//!   from WebView2's LostFocus, which never fires when the page didn't get the keyboard focus). The
//!   WebView2 controller is hidden with the window and made visible again before a show.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::vault::VaultState;

pub const WINDOW_LABEL: &str = "quick-search";
pub const DEFAULT_COMBO: &str = "Ctrl+Alt+K";
const CONFIG_FILE: &str = "quick_search.json";
/// Emitted to the quick-search window each time it is shown (reset the query, refresh).
const SHOWN_EVENT: &str = "quick-search:shown";
/// Emitted to the main window: open an entry (`{ rel }`) / open the unlock dialog.
pub(crate) const OPEN_EVENT: &str = "quick-search:open";
const UNLOCK_EVENT: &str = "quick-search:unlock";
/// Emitted to the quick-search window whenever Rust hides it (stop the 2FA timers, drop codes).
const HIDDEN_EVENT: &str = "quick-search:hidden";

// ─── config (pure) ───────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QuickSearchConfig {
    pub enabled: bool,
    pub combo: String,
}

impl Default for QuickSearchConfig {
    fn default() -> Self {
        QuickSearchConfig { enabled: false, combo: DEFAULT_COMBO.into() }
    }
}

/// Tolerant parse: a missing / broken file means "off"; an invalid combo falls back to the default.
pub fn parse_config(s: &str) -> QuickSearchConfig {
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        enabled: Option<bool>,
        #[serde(default)]
        combo: Option<String>,
    }
    let Ok(raw) = serde_json::from_str::<Raw>(s) else { return QuickSearchConfig::default() };
    let combo = raw
        .combo
        .and_then(|c| validate_combo(&c).ok())
        .unwrap_or_else(|| DEFAULT_COMBO.to_string());
    QuickSearchConfig { enabled: raw.enabled.unwrap_or(false), combo }
}

/// A parsed key combination ("Ctrl+Alt+K").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    /// "A".."Z", "0".."9", "F1".."F12" or "Space".
    pub key: String,
}

impl Combo {
    /// Canonical text, same order as the frontend's `comboFromEvent` (Ctrl, Alt, Shift, Meta, key).
    pub fn canonical(&self) -> String {
        let mut parts: Vec<&str> = vec![];
        if self.ctrl { parts.push("Ctrl"); }
        if self.alt { parts.push("Alt"); }
        if self.shift { parts.push("Shift"); }
        if self.meta { parts.push("Meta"); }
        parts.push(&self.key);
        parts.join("+")
    }
}

/// Parses and checks a combo. A global shortcut must hold Ctrl, Alt or Meta (a bare key or
/// Shift+key would fire while typing in every other app) and exactly one supported key.
pub fn parse_combo(s: &str) -> Result<Combo, String> {
    let s = s.trim();
    if s.is_empty() || s.len() > 64 {
        return Err("Enter a key combination".into());
    }
    let mut c = Combo { ctrl: false, alt: false, shift: false, meta: false, key: String::new() };
    for part in s.split('+').map(str::trim) {
        let up = part.to_ascii_uppercase();
        let slot = match up.as_str() {
            "CTRL" | "CONTROL" => &mut c.ctrl,
            "ALT" | "OPTION" => &mut c.alt,
            "SHIFT" => &mut c.shift,
            "META" | "CMD" | "COMMAND" | "SUPER" | "WIN" => &mut c.meta,
            _ => {
                if !c.key.is_empty() {
                    return Err("Use only one key besides the modifiers".into());
                }
                c.key = normalize_key(&up).ok_or_else(|| format!("\"{part}\" can't be used in a global shortcut"))?;
                continue;
            }
        };
        if *slot {
            return Err("A modifier is repeated".into());
        }
        *slot = true;
    }
    if c.key.is_empty() {
        return Err("Add a key (a letter, digit or F1–F12)".into());
    }
    if !(c.ctrl || c.alt || c.meta) {
        return Err("Use Ctrl, Alt or Cmd with a key".into());
    }
    Ok(c)
}

/// Canonical form of a valid combo, or a user-facing reason why it can't be used.
pub fn validate_combo(s: &str) -> Result<String, String> {
    parse_combo(s).map(|c| c.canonical())
}

fn normalize_key(up: &str) -> Option<String> {
    let b = up.as_bytes();
    if b.len() == 1 && (b[0].is_ascii_uppercase() || b[0].is_ascii_digit()) {
        return Some(up.to_string());
    }
    if up == "SPACE" {
        return Some("Space".into());
    }
    if let Some(n) = up.strip_prefix('F').and_then(|n| n.parse::<u8>().ok()) {
        if (1..=12).contains(&n) && !up[1..].starts_with('0') {
            return Some(format!("F{n}"));
        }
    }
    None
}

// ─── index (pure) ────────────────────────────────────────────────────────────

/// What the quick-search list shows for one entry. Never holds a secret.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct IndexItem {
    pub rel: String,
    pub ext: String,
    pub tags: Vec<String>,
    pub starred: bool,
    pub updated: u64,
    /// Display host: a login's main site, an SSH host, or an API key's service.
    pub host: String,
    /// Every site / host string the entry can be found by.
    pub urls: Vec<String>,
    /// A login with a usable 2FA (TOTP) secret. Only the flag: the secret stays in the vault.
    pub totp: bool,
}

/// Host of a URL or bare domain: `https://user@Accounts.Google.com:443/x` → `accounts.google.com`.
pub fn host_of(url: &str) -> String {
    let t = url.trim();
    let t = match t.find("://") {
        Some(i) => &t[i + 3..],
        None => t,
    };
    let t = t.split(['/', '?', '#']).next().unwrap_or("");
    let t = t.rsplit('@').next().unwrap_or("");
    let t = if t.starts_with('[') {
        t // IPv6 literal: leave as is
    } else {
        t.split(':').next().unwrap_or("")
    };
    t.to_ascii_lowercase()
}

/// Reads only the non-secret fields of an entry's JSON (unknown fields, passwords included,
/// are skipped by serde without being copied).
pub fn index_fields(ext: &str, content: &str) -> (String, Vec<String>) {
    #[derive(Deserialize, Default)]
    struct Login {
        #[serde(default)]
        url: String,
        #[serde(default)]
        urls: Vec<String>,
    }
    #[derive(Deserialize, Default)]
    struct Fields {
        #[serde(default)]
        host: String,
        #[serde(default)]
        service: String,
        #[serde(default)]
        ssid: String,
    }
    #[derive(Deserialize, Default)]
    struct Structured {
        #[serde(default)]
        fields: Fields,
        /// Recovery-code entries keep their service at the top level.
        #[serde(default)]
        service: String,
    }
    match ext {
        "login" => {
            let l: Login = serde_json::from_str(content).unwrap_or_default();
            let mut urls: Vec<String> = vec![];
            for u in std::iter::once(&l.url).chain(l.urls.iter().take(20)) {
                let u = u.trim();
                if !u.is_empty() && !urls.iter().any(|x| x.eq_ignore_ascii_case(u)) {
                    urls.push(u.chars().take(512).collect());
                }
            }
            let host = urls.first().map(|u| host_of(u)).unwrap_or_default();
            (host, urls)
        }
        "ssh" | "secret" => {
            let s: Structured = serde_json::from_str(content).unwrap_or_default();
            let v = if ext == "ssh" { s.fields.host } else { s.fields.service };
            let v: String = v.trim().chars().take(256).collect();
            let urls = if v.is_empty() { vec![] } else { vec![v.clone()] };
            (v, urls)
        }
        "wifi" | "codes" => {
            let s: Structured = serde_json::from_str(content).unwrap_or_default();
            let v = if ext == "wifi" { s.fields.ssid } else { s.service };
            let v: String = v.trim().chars().take(256).collect();
            let urls = if v.is_empty() { vec![] } else { vec![v.clone()] };
            (v, urls)
        }
        _ => (String::new(), vec![]),
    }
}

// ─── 2-step codes (pure) ─────────────────────────────────────────────────────

/// TOTP step in seconds (RFC 6238 default; the same as `totpCode` in src/lib/loginEntry.ts).
pub const TOTP_PERIOD: u64 = 30;
const TOTP_DIGITS: u32 = 6;

/// RFC 4648 base32, case-insensitive; whitespace, `-` and `=` are ignored (same rules as the
/// frontend's `base32Decode`). `None` for an empty or invalid secret.
fn base32_decode(s: &str) -> Option<zeroize::Zeroizing<Vec<u8>>> {
    const A: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = zeroize::Zeroizing::new(Vec::with_capacity(s.len() * 5 / 8));
    let (mut bits, mut val) = (0u32, 0u32);
    for ch in s.chars().filter(|c| !c.is_whitespace() && *c != '-' && *c != '=') {
        let up = ch.to_ascii_uppercase();
        let i = A.iter().position(|&a| a as char == up)? as u32;
        val = ((val << 5) | i) & 0xffff;
        bits += 5;
        if bits >= 8 {
            out.push(((val >> (bits - 8)) & 0xff) as u8);
            bits -= 8;
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// RFC 6238 code (HMAC-SHA1, 6 digits, 30 s) for `secret` at `unix_secs`. `None` if the secret is invalid.
pub fn totp_at(secret: &str, unix_secs: u64) -> Option<String> {
    let key = base32_decode(secret)?;
    let counter = unix_secs / TOTP_PERIOD;
    let k = ring::hmac::Key::new(ring::hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, &key);
    let tag = ring::hmac::sign(&k, &counter.to_be_bytes());
    let h = tag.as_ref();
    let o = (h[h.len() - 1] & 15) as usize;
    let bin = u32::from_be_bytes([h[o] & 0x7f, h[o + 1], h[o + 2], h[o + 3]]);
    Some(format!("{:0width$}", bin % 10u32.pow(TOTP_DIGITS), width = TOTP_DIGITS as usize))
}

/// Whole seconds left in the TOTP step that contains `unix_secs` (1..=30).
pub fn totp_remaining(unix_secs: u64) -> u64 {
    TOTP_PERIOD - unix_secs % TOTP_PERIOD
}

/// Reads only the `totp` field of a login's JSON (password, notes, … are skipped by serde).
fn login_totp_secret(content: &str) -> Option<zeroize::Zeroizing<String>> {
    #[derive(Deserialize, Default)]
    struct Login {
        #[serde(default)]
        totp: String,
    }
    let l: Login = serde_json::from_str(content).ok()?;
    let s = zeroize::Zeroizing::new(l.totp);
    if s.trim().is_empty() { None } else { Some(s) }
}

/// Does this entry have a usable 2FA secret? (For the index flag; never returns the secret.)
pub fn has_totp(ext: &str, content: &str) -> bool {
    ext == "login" && login_totp_secret(content).is_some_and(|s| base32_decode(&s).is_some())
}

/// The current code of one login: what `quick_search_totp` returns.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct TotpNow {
    pub code: String,
    /// Seconds the code is still valid (1..=30).
    pub remaining: u64,
    pub period: u64,
}

/// The code of a login's 2FA secret at `unix_ms`, or `None` (not a login / no or bad secret).
pub fn totp_now(ext: &str, content: &str, unix_ms: u64) -> Option<TotpNow> {
    if ext != "login" {
        return None;
    }
    let secs = unix_ms / 1000;
    let code = totp_at(&login_totp_secret(content)?, secs)?;
    Some(TotpNow { code, remaining: totp_remaining(secs), period: TOTP_PERIOD })
}

// ─── runtime state ───────────────────────────────────────────────────────────

#[cfg(desktop)]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

/// The shortcut we currently hold, and the last registration error (shown in Settings).
#[cfg(desktop)]
static CURRENT: Mutex<Option<Shortcut>> = Mutex::new(None);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

fn set_error(e: Option<String>) {
    *LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()) = e;
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(CONFIG_FILE))
}

fn load_config(app: &AppHandle) -> QuickSearchConfig {
    config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| parse_config(&s))
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, cfg: &QuickSearchConfig) -> Result<(), String> {
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    crate::vault::atomic_write(&config_path(app)?, json.as_bytes())
}

#[cfg(desktop)]
fn to_shortcut(c: &Combo) -> Result<Shortcut, String> {
    let mut m = Modifiers::empty();
    if c.ctrl { m |= Modifiers::CONTROL; }
    if c.alt { m |= Modifiers::ALT; }
    if c.shift { m |= Modifiers::SHIFT; }
    if c.meta { m |= Modifiers::SUPER; }
    let code_name = match c.key.as_str() {
        k if k.len() == 1 && k.as_bytes()[0].is_ascii_digit() => format!("Digit{k}"),
        k if k.len() == 1 => format!("Key{k}"),
        k => k.to_string(), // "F1".."F12", "Space"
    };
    let code: Code = code_name.parse().map_err(|_| format!("Unsupported key \"{}\"", c.key))?;
    Ok(Shortcut::new(Some(m), code))
}

/// Registers the shortcut described by `cfg` (dropping any previous one).
#[cfg(desktop)]
fn apply(app: &AppHandle, cfg: &QuickSearchConfig) -> Result<(), String> {
    let gs = app.global_shortcut();
    let mut cur = CURRENT.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(old) = cur.take() {
        let _ = gs.unregister(old);
    }
    if !cfg.enabled {
        return Ok(());
    }
    let combo = parse_combo(&cfg.combo)?;
    let sc = to_shortcut(&combo)?;
    gs.register(sc).map_err(|e| {
        format!(
            "{} couldn't be registered — another app (or Windows) is probably using it. Choose a different shortcut. ({e})",
            combo.canonical()
        )
    })?;
    *cur = Some(sc);
    Ok(())
}

#[cfg(not(desktop))]
fn apply(_app: &AppHandle, cfg: &QuickSearchConfig) -> Result<(), String> {
    if cfg.enabled { Err("Quick search is only available on desktop".into()) } else { Ok(()) }
}

/// The global-shortcut plugin, with the handler that toggles the window.
#[cfg(desktop)]
pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            // Only our own, currently registered combo opens the popup.
            let ours = CURRENT.lock().unwrap_or_else(|p| p.into_inner()).as_ref() == Some(shortcut);
            if ours && event.state() == ShortcutState::Pressed {
                on_hotkey(app);
            }
        })
        .build()
}

/// Startup: register the saved shortcut (if enabled). Errors are kept for the Settings row.
pub fn start(app: &AppHandle) {
    let cfg = load_config(app);
    set_error(apply(app, &cfg).err());
}

// ─── foreground window (restore focus after a copy) ──────────────────────────

/// The window that was active when the hotkey was pressed (raw HWND as an integer).
#[cfg(windows)]
static PREV_FOREGROUND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

#[cfg(windows)]
fn remember_foreground(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    // SAFETY: plain query with no arguments.
    let h = unsafe { GetForegroundWindow() };
    // Pressing the hotkey while our own quick window is in front must not overwrite the target.
    let ours = app
        .get_webview_window(WINDOW_LABEL)
        .and_then(|w| w.hwnd().ok())
        .is_some_and(|w| w.0 as isize == h as isize);
    if !ours {
        PREV_FOREGROUND.store(h as isize, std::sync::atomic::Ordering::Release);
    }
}
#[cfg(not(windows))]
fn remember_foreground(_app: &AppHandle) {}

#[cfg(windows)]
fn restore_foreground() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    let h = PREV_FOREGROUND.swap(0, std::sync::atomic::Ordering::AcqRel) as windows_sys::Win32::Foundation::HWND;
    // SAFETY: both calls tolerate stale handles (checked with IsWindow first). We are the foreground
    // process at this point (the quick window had the focus), so Windows allows the switch.
    unsafe {
        if !h.is_null() && IsWindow(h) != 0 {
            SetForegroundWindow(h);
        }
    }
}
#[cfg(not(windows))]
fn restore_foreground() {}

// ─── window lifecycle (pure) ─────────────────────────────────────────────────

/// How long a show waits for the page to report ready (`quick_search_ready`) before showing the
/// window anyway (dark background + the page's own "Loading…" state, never a white page).
pub const READY_WAIT_MS: u64 = 1500;
/// After a show, how long a page that *was* ready gets to acknowledge the `shown` event. No answer
/// means its JS is dead (renderer crashed / page blanked): the webview is reloaded.
pub const ALIVE_WAIT_MS: u64 = 2500;

/// What a pending show does next, given whether the page is ready and how long it has waited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShowStep {
    /// Keep the window hidden a little longer.
    Wait,
    /// Show it now; `ready` is false when the wait timed out.
    Show { ready: bool },
}

pub fn show_step(ready: bool, waited_ms: u64, limit_ms: u64) -> ShowStep {
    if ready {
        ShowStep::Show { ready: true }
    } else if waited_ms >= limit_ms {
        ShowStep::Show { ready: false }
    } else {
        ShowStep::Wait
    }
}

/// A focus change of the quick window: hide it when it lost the focus while on screen (the user
/// clicked or switched elsewhere). Deliberate actions (copy, open, unlock) hide it themselves first,
/// so by the time their focus loss arrives the window is no longer visible.
pub fn hide_on_blur(focused: bool, visible: bool) -> bool {
    !focused && visible
}

/// The page was ready when shown but never answered the `shown` event: its JS is gone.
pub fn needs_reload(was_ready: bool, acked: bool) -> bool {
    was_ready && !acked
}

/// After a show, how long the window may stay without the foreground (activation still on its way,
/// or refused once by Windows' foreground lock) before the guard treats it as "the user moved on".
pub const SHOW_GRACE_MS: u64 = 1000;
/// Another window must hold the foreground this long before the guard hides the quick window (rides
/// out the brief "no / other foreground" moments of a focus hand-over).
pub const BLUR_CONFIRM_MS: u64 = 250;
/// How long after the popup's "Unlock" a successful unlock in the main window may bring it back.
pub const REOPEN_WINDOW_MS: u64 = 5 * 60 * 1000;

/// Who holds the foreground, as far as the quick window is concerned.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Foreground {
    /// The quick window (or a popup it owns).
    Ours,
    /// Another window, of this app or another one.
    Other,
    /// No foreground window right now (a hand-over in progress, the lock screen, …).
    None,
}

/// What the visibility guard does on one tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardAction {
    Nothing,
    /// Take the window off screen.
    Hide,
    /// Ask for the focus again (a show whose activation hasn't landed yet).
    Refocus,
}

/// The visibility guard, one tick (pure). `open` is the user's intent (set only by a show that came
/// from the hotkey or an explicit reopen, cleared by every hide); `visible` is what the OS reports.
///
/// * On screen without the user asking for it (any source: a stale show that lost a race with a
///   hide, a WebView2 / OS quirk): hide it.
/// * On screen as asked, but another window holds the foreground: right after the show keep asking
///   for the focus; afterwards hide it. This is the outside-click close that doesn't depend on
///   WebView2 reporting a focus loss (it never does when its content didn't get the focus).
pub fn guard_step(open: bool, visible: bool, fg: Foreground, since_show_ms: u64, away_ms: u64) -> GuardAction {
    if !visible {
        return GuardAction::Nothing;
    }
    if !open {
        return GuardAction::Hide;
    }
    match fg {
        Foreground::Ours | Foreground::None => GuardAction::Nothing,
        Foreground::Other if since_show_ms < SHOW_GRACE_MS => GuardAction::Refocus,
        Foreground::Other if away_ms >= BLUR_CONFIRM_MS => GuardAction::Hide,
        Foreground::Other => GuardAction::Nothing,
    }
}

/// May `quick_search_reopen` show the popup? Only once, and only shortly after the popup itself sent
/// the user to the main window to unlock (`requested_at_ms`). Anything else that unlocks the vault
/// (another dialog, a sync flow, a waiter left over from long ago) never brings it back.
pub fn reopen_allowed(requested_at_ms: u64, now_ms: u64) -> bool {
    requested_at_ms != 0 && now_ms >= requested_at_ms && now_ms - requested_at_ms <= REOPEN_WINDOW_MS
}

// ─── window ──────────────────────────────────────────────────────────────────

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// The page listens for its events (set by `quick_search_ready`, cleared when a load starts).
static READY: AtomicBool = AtomicBool::new(false);
/// Bumped by every show request and every hide: a show whose generation is stale was cancelled
/// (hidden, toggled off) while it waited, and must not put the window on screen.
static SHOW_GEN: AtomicU64 = AtomicU64::new(0);
/// The latest generation the page acknowledged (`quick_search_ready` after mount or a `shown` event).
static ACK_GEN: AtomicU64 = AtomicU64::new(0);
/// A show was requested and is still waiting for the page (the window isn't visible yet).
static PENDING: AtomicBool = AtomicBool::new(false);
/// The user wants the window on screen: set right before a show that came from the hotkey or an
/// allowed reopen puts it up, cleared by every hide. The guard takes the window off screen whenever
/// the OS reports it visible without this (whatever put it there).
static OPEN: AtomicBool = AtomicBool::new(false);
/// `mono_ms()` of the show that set `OPEN` (the guard's grace period starts there).
static SHOWN_AT: AtomicU64 = AtomicU64::new(0);
/// `mono_ms()` of the popup's last "Unlock" (0 = none): lets exactly one `quick_search_reopen` through.
static UNLOCK_REQUESTED_AT: AtomicU64 = AtomicU64::new(0);

/// Milliseconds on a monotonic clock, starting at 1 (so 0 can mean "never").
fn mono_ms() -> u64 {
    static BASE: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    BASE.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
}

/// The WebView2 controller follows the window: hidden with it (Chromium stops rendering and can't
/// pull the keyboard focus into an off-screen window), visible again right before it is shown, so the
/// page repaints instead of showing a stale / blank surface.
fn set_webview_visible(w: &tauri::WebviewWindow, visible: bool) {
    #[cfg(windows)]
    let _ = w.with_webview(move |pw| unsafe {
        let c = pw.controller();
        let _ = c.SetIsVisible(visible);
        if visible {
            let _ = c.NotifyParentWindowPositionChanged();
        }
    });
    #[cfg(not(windows))]
    let _ = (w, visible);
}

/// Takes the window off screen without touching the show bookkeeping (the guard uses it for a window
/// that is visible although nobody asked for it).
fn force_hide(app: &AppHandle, w: &tauri::WebviewWindow) {
    let _ = w.hide();
    set_webview_visible(w, false);
    let _ = app.emit_to(WINDOW_LABEL, HIDDEN_EVENT, ());
}

/// Hides the quick window and tells it so (it stops its 2FA timers and forgets the codes and the
/// query). Every hide goes through here; it also cancels a show that is still waiting.
fn hide_quick(app: &AppHandle) {
    OPEN.store(false, Ordering::Release);
    SHOW_GEN.fetch_add(1, Ordering::AcqRel);
    PENDING.store(false, Ordering::Release);
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        force_hide(app, &w);
    }
}

/// Who holds the foreground relative to the quick window `ours`.
#[cfg(windows)]
fn foreground_of(ours: isize) -> Foreground {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GA_ROOTOWNER};
    // SAFETY: plain queries; a stale handle only yields null / another window.
    let fg = unsafe { GetForegroundWindow() };
    if fg.is_null() {
        return Foreground::None;
    }
    let root = unsafe { GetAncestor(fg, GA_ROOTOWNER) };
    if fg as isize == ours || root as isize == ours { Foreground::Ours } else { Foreground::Other }
}

/// Does the quick window hold the foreground? (Tauri's `is_focused` is false on Windows while the
/// WebView2 child holds the keyboard focus, i.e. almost always, so it can't answer this.)
#[cfg(desktop)]
fn has_foreground(w: &tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        w.hwnd().is_ok_and(|h| foreground_of(h.0 as isize) == Foreground::Ours)
    }
    #[cfg(not(windows))]
    {
        w.is_focused().unwrap_or(false)
    }
}

/// How often the guard looks at the window.
#[cfg(windows)]
const GUARD_TICK_MS: u64 = 150;

/// The visibility guard (Windows): one thread for the app's lifetime, two cheap Win32 queries per
/// tick, decisions in `guard_step`. It keeps the window off screen unless the user asked for it, and
/// closes it on an outside click even when WebView2 never reports the focus loss.
#[cfg(windows)]
fn start_guard(app: &AppHandle) {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible;
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut away_since: Option<u64> = None;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(GUARD_TICK_MS));
            let Some(w) = app.get_webview_window(WINDOW_LABEL) else { continue };
            let Ok(h) = w.hwnd() else { continue };
            let h = h.0 as isize;
            // SAFETY: plain query on our own window handle.
            let visible = unsafe { IsWindowVisible(h as _) } != 0;
            let fg = foreground_of(h);
            let now = mono_ms();
            away_since = match fg {
                Foreground::Other => Some(away_since.unwrap_or(now)),
                _ => None,
            };
            let away = away_since.map_or(0, |t| now - t);
            let open = OPEN.load(Ordering::Acquire);
            let since_show = now.saturating_sub(SHOWN_AT.load(Ordering::Acquire));
            match guard_step(open, visible, fg, since_show, away) {
                GuardAction::Hide if open => {
                    // An outside click / app switch the focus events missed: same as `on_window_event`.
                    hide_quick(&app);
                    forget_foreground();
                }
                GuardAction::Hide => force_hide(&app, &w),
                GuardAction::Refocus => {
                    let _ = w.set_focus();
                }
                GuardAction::Nothing => {}
            }
        }
    });
}

#[cfg(windows)]
fn forget_foreground() {
    PREV_FOREGROUND.store(0, Ordering::Release);
}
#[cfg(not(windows))]
fn forget_foreground() {}

/// Window events of the quick window (wired in lib.rs): an outside click / app switch hides it, and
/// closing it (Alt+F4) only hides it, so the loaded page is kept for the next hotkey press.
pub fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    match event {
        tauri::WindowEvent::Focused(focused) => {
            let visible = window.is_visible().unwrap_or(false);
            if hide_on_blur(*focused, visible) {
                // The user moved on: don't hand the focus back to the app from before the hotkey.
                hide_quick(window.app_handle());
                forget_foreground();
            }
        }
        tauri::WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_quick(window.app_handle());
            restore_foreground();
        }
        _ => {}
    }
}

/// Starts a show off the event-loop thread (creating a webview from it can deadlock on Windows,
/// and the show waits for the page).
#[cfg(desktop)]
fn request_show(app: &AppHandle) {
    let gen = SHOW_GEN.fetch_add(1, Ordering::AcqRel) + 1;
    PENDING.store(true, Ordering::Release);
    let app = app.clone();
    std::thread::spawn(move || show_window(&app, gen));
}

#[cfg(desktop)]
fn on_hotkey(app: &AppHandle) {
    // The user is driving the popup directly now: an older "unlock, then come back" is void.
    UNLOCK_REQUESTED_AT.store(0, Ordering::Release);
    let w = app.get_webview_window(WINDOW_LABEL);
    let visible = w.as_ref().is_some_and(|w| w.is_visible().unwrap_or(false));
    // Pressing the shortcut again closes the window, focused or not (and cancels a pending show).
    if visible || PENDING.load(Ordering::Acquire) {
        let focused = w.as_ref().is_some_and(has_foreground);
        hide_quick(app);
        if focused { restore_foreground() } else { forget_foreground() }
        return;
    }
    remember_foreground(app);
    request_show(app);
}

#[cfg(desktop)]
fn create_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
    READY.store(false, Ordering::Release);
    let w = tauri::WebviewWindowBuilder::new(app, WINDOW_LABEL, tauri::WebviewUrl::App("index.html#/quick-search".into()))
        .title(if crate::profile::IS_DEV { "Notiq Dev Quick Search" } else { "Notiq Quick Search" })
        .inner_size(560.0, 400.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(true)
        // Window *and* webview background: the app's dark theme until the page paints.
        .background_color(tauri::window::Color(15, 23, 42, 255))
        .visible(false)
        .focused(false)
        .center()
        // A (re)load means the page no longer listens until it reports ready again.
        .on_page_load(|_w, p| {
            if p.event() == tauri::webview::PageLoadEvent::Started {
                READY.store(false, Ordering::Release);
            }
        })
        .build()
        .map_err(|e| e.to_string())?;
    // Hidden window, hidden webview: nothing renders or grabs the focus until a show.
    set_webview_visible(&w, false);
    crate::capture_shield::refresh(app);
    #[cfg(windows)]
    start_guard(app);
    Ok(w)
}

#[cfg(desktop)]
fn show_window(app: &AppHandle, gen: u64) {
    let current = || SHOW_GEN.load(Ordering::Acquire) == gen;
    let w = match app.get_webview_window(WINDOW_LABEL) {
        Some(w) => w,
        None => match create_window(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("quick_search: cannot create window: {e}");
                PENDING.store(false, Ordering::Release);
                return;
            }
        },
    };
    // Wait (hidden) until the page listens, so it never shows up blank / white.
    let start = std::time::Instant::now();
    let ready = loop {
        if !current() {
            return; // hidden or toggled off meanwhile
        }
        match show_step(READY.load(Ordering::Acquire), start.elapsed().as_millis() as u64, READY_WAIT_MS) {
            ShowStep::Show { ready } => break ready,
            ShowStep::Wait => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    };
    if !current() {
        return;
    }
    // The only place the quick window goes on screen: a show the user asked for (hotkey / reopen).
    SHOWN_AT.store(mono_ms(), Ordering::Release);
    OPEN.store(true, Ordering::Release);
    let _ = w.center();
    set_webview_visible(&w, true);
    let _ = w.unminimize();
    let _ = w.show();
    let _ = w.set_focus();
    PENDING.store(false, Ordering::Release);
    // A hide that landed between the check above and `show()` (outside click, hotkey again, quick
    // search turned off) must win: take the window down again instead of leaving it up unasked.
    if !current() {
        if !OPEN.load(Ordering::Acquire) {
            force_hide(app, &w);
        }
        return;
    }
    let _ = app.emit_to(WINDOW_LABEL, SHOWN_EVENT, ());

    // Without the focus an outside click never blurs the window: retry briefly in case Windows'
    // foreground lock refused the first attempt. (On Windows the guard does this, and it also closes
    // a window that never got the focus.)
    #[cfg(not(windows))]
    for _ in 0..4 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if !current() {
            return;
        }
        if has_foreground(&w) {
            break;
        }
        let _ = w.set_focus();
    }

    // A page that was ready must acknowledge the `shown` event; if it doesn't, its JS is dead
    // (crashed renderer, blank page): reload it so the window recovers instead of staying blank.
    let start = std::time::Instant::now();
    while start.elapsed().as_millis() < ALIVE_WAIT_MS as u128 {
        if !current() || ACK_GEN.load(Ordering::Acquire) >= gen {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    if current() && needs_reload(ready, ACK_GEN.load(Ordering::Acquire) >= gen) {
        eprintln!("quick_search: the page did not answer; reloading it");
        let _ = w.reload();
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct QuickSearchStatus {
    enabled: bool,
    combo: String,
    default_combo: &'static str,
    /// Why the shortcut isn't active (registration failed), if it isn't.
    error: Option<String>,
}

fn status(cfg: QuickSearchConfig) -> QuickSearchStatus {
    QuickSearchStatus {
        enabled: cfg.enabled,
        combo: cfg.combo,
        default_combo: DEFAULT_COMBO,
        error: LAST_ERROR.lock().unwrap_or_else(|p| p.into_inner()).clone(),
    }
}

#[tauri::command]
pub fn quick_search_get(app: AppHandle) -> QuickSearchStatus {
    status(load_config(&app))
}

/// Saves + applies the setting. If the new shortcut can't be registered, the previous setting
/// is put back and the error is returned (nothing is saved).
#[tauri::command]
pub fn quick_search_set(app: AppHandle, enabled: bool, combo: String) -> Result<QuickSearchStatus, String> {
    let combo = validate_combo(&combo)?;
    let next = QuickSearchConfig { enabled, combo };
    let prev = load_config(&app);
    if let Err(e) = apply(&app, &next) {
        set_error(apply(&app, &prev).err());
        return Err(e);
    }
    save_config(&app, &next)?;
    set_error(None);
    if !enabled {
        hide_quick(&app);
    }
    Ok(status(next))
}

/// Hides the quick window; `restore` hands the focus back to the window that was active before.
#[tauri::command]
pub fn quick_search_hide(app: AppHandle, restore: bool) {
    hide_quick(&app);
    if restore {
        restore_foreground();
    } else {
        forget_foreground();
    }
}

/// The quick window's page listens for its events: sent after mount and in answer to every
/// `quick-search:shown`. A show waits for it (no blank window) and a missing answer after a show
/// means the page died (it is then reloaded). Ignored for every other window.
///
/// Answers whether the window is on screen at the user's request: a page that (re)loaded while it is
/// (a show that timed out waiting, a reload) missed the `shown` event and must act on it. This never
/// shows the window; only `show_window` does.
#[tauri::command]
pub fn quick_search_ready(window: tauri::Window) -> bool {
    if window.label() != WINDOW_LABEL {
        return false;
    }
    READY.store(true, Ordering::Release);
    ACK_GEN.store(SHOW_GEN.load(Ordering::Acquire), Ordering::Release);
    OPEN.load(Ordering::Acquire)
}

/// Brings the main window forward and asks it to open an entry (`rel`) or the unlock dialog.
#[tauri::command]
pub fn quick_search_show_main(app: AppHandle, action: String, rel: Option<String>) -> Result<(), String> {
    hide_quick(&app);
    // After an unlock the popup comes back (`quick_search_reopen`, once, for a short while) and a copy
    // should still return the focus to the original app; opening an entry ends the session.
    if action == "unlock" {
        UNLOCK_REQUESTED_AT.store(mono_ms(), Ordering::Release);
    } else {
        UNLOCK_REQUESTED_AT.store(0, Ordering::Release);
        forget_foreground();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    match action.as_str() {
        "unlock" => app.emit_to("main", UNLOCK_EVENT, ()).map_err(|e| e.to_string()),
        "open" => {
            let rel = rel.filter(|r| !r.is_empty() && r.len() < 4096).ok_or("Missing entry")?;
            app.emit_to("main", OPEN_EVENT, serde_json::json!({ "rel": rel })).map_err(|e| e.to_string())
        }
        _ => Err("Unknown action".into()),
    }
}

/// Shows the popup again (used by the main window once an unlock started from the popup succeeded).
/// Honoured once, and only shortly after the popup's own "Unlock" (`reopen_allowed`): an unrelated
/// unlock, or a stale waiter in the main window, never puts the popup on screen. Main window only.
#[tauri::command]
pub fn quick_search_reopen(app: AppHandle, window: tauri::Window) {
    if window.label() != "main" {
        return;
    }
    if !reopen_allowed(UNLOCK_REQUESTED_AT.swap(0, Ordering::AcqRel), mono_ms()) {
        return;
    }
    #[cfg(desktop)]
    request_show(&app);
    #[cfg(not(desktop))]
    let _ = app;
}

/// Names, kinds, tags and hosts of every live entry (no secrets, no note content).
#[tauri::command]
pub fn quick_search_index(state: State<'_, VaultState>) -> Result<Vec<IndexItem>, String> {
    state.with_db(|db, _, _, _| {
        let items = db
            .entries
            .values()
            .filter(|e| e.is_live() && !e.dir)
            .map(|e| {
                let (host, urls) = index_fields(&e.ext, &e.content);
                IndexItem {
                    rel: e.path.clone(), ext: e.ext.clone(), tags: e.tags.clone(), starred: e.starred,
                    updated: e.updated, host, urls, totp: has_totp(&e.ext, &e.content),
                }
            })
            .collect();
        Ok((items, false))
    })
}

/// The current 2FA code + seconds left of one login (`rel` from `quick_search_index`). Only the code
/// crosses to the WebView, never the secret. Refused for every window but the quick window, and
/// with `VAULT_LOCKED` while the vault is locked.
#[tauri::command]
pub fn quick_search_totp(window: tauri::Window, state: State<'_, VaultState>, rel: String) -> Result<TotpNow, String> {
    if window.label() != WINDOW_LABEL {
        return Err("Not allowed".into());
    }
    if rel.is_empty() || rel.len() > 4096 {
        return Err("Missing entry".into());
    }
    state.with_db(|db, _, _, _| {
        let e = db.get(&rel).ok_or("Entry not found")?;
        let now = totp_now(&e.ext, &e.content, crate::vault_db::now_ms()).ok_or("This login has no 2FA code")?;
        Ok((now, false))
    })
}

/// First 8 hex chars of the vault id: a non-secret fingerprint printed on the recovery kit so a
/// kit can be matched to its vault. (The id is stored in the clear in vault.json.)
#[tauri::command]
pub fn vault_fingerprint(app: AppHandle) -> Result<String, String> {
    let meta = crate::vault::require_meta(&app)?;
    Ok(meta.vault_id.chars().take(8).collect::<String>().to_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_parse_is_tolerant() {
        assert_eq!(parse_config(""), QuickSearchConfig::default());
        assert_eq!(parse_config("not json"), QuickSearchConfig::default());
        assert_eq!(parse_config("{}"), QuickSearchConfig::default());
        assert_eq!(
            parse_config(r#"{"enabled":true,"combo":"ctrl+shift+space"}"#),
            QuickSearchConfig { enabled: true, combo: "Ctrl+Shift+Space".into() }
        );
        // A bad combo keeps the enabled flag but falls back to the default keys.
        assert_eq!(
            parse_config(r#"{"enabled":true,"combo":"K"}"#),
            QuickSearchConfig { enabled: true, combo: DEFAULT_COMBO.into() }
        );
        assert_eq!(parse_config(r#"{"enabled":"yes"}"#), QuickSearchConfig::default());
    }

    #[test]
    fn config_round_trips() {
        let c = QuickSearchConfig { enabled: true, combo: "Alt+F9".into() };
        assert_eq!(parse_config(&serde_json::to_string(&c).unwrap()), c);
        assert!(!QuickSearchConfig::default().enabled);
        assert_eq!(QuickSearchConfig::default().combo, "Ctrl+Alt+K");
    }

    #[test]
    fn combos_are_validated_and_canonical() {
        assert_eq!(validate_combo("Ctrl+Alt+K").unwrap(), "Ctrl+Alt+K");
        assert_eq!(validate_combo(" alt + ctrl + k ").unwrap(), "Ctrl+Alt+K");
        assert_eq!(validate_combo("Control+Shift+7").unwrap(), "Ctrl+Shift+7");
        assert_eq!(validate_combo("Cmd+Space").unwrap(), "Meta+Space");
        assert_eq!(validate_combo("Alt+f12").unwrap(), "Alt+F12");
        for bad in ["", "K", "Shift+K", "F5", "Ctrl+Alt", "Ctrl+Ctrl+K", "Ctrl+K+J", "Ctrl+F13", "Ctrl+F0",
                    "Ctrl+F01", "Ctrl+Delete", "Ctrl+Tab", "Ctrl+é", "Ctrl+AB"] {
            assert!(validate_combo(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[cfg(desktop)]
    #[test]
    fn combos_map_to_shortcuts() {
        for c in ["Ctrl+Alt+K", "Alt+5", "Ctrl+Shift+Space", "Meta+F1", "Ctrl+Alt+Shift+Meta+Z"] {
            to_shortcut(&parse_combo(c).unwrap()).unwrap_or_else(|e| panic!("{c}: {e}"));
        }
        let s = to_shortcut(&parse_combo("Ctrl+Alt+K").unwrap()).unwrap();
        assert_eq!(s, Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyK));
    }

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://user@Accounts.Google.com:443/x?y#z"), "accounts.google.com");
        assert_eq!(host_of("github.com/login"), "github.com");
        assert_eq!(host_of("  "), "");
        assert_eq!(host_of("ftp://example.org"), "example.org");
    }

    #[test]
    fn index_never_reads_secrets() {
        let login = r#"{"v":1,"kind":"login","title":"G","url":"https://mail.google.com/","urls":["google.com"," ","GOOGLE.COM"],"username":"me","password":"hunter2","totp":"ABC"}"#;
        let (host, urls) = index_fields("login", login);
        assert_eq!(host, "mail.google.com");
        assert_eq!(urls, vec!["https://mail.google.com/".to_string(), "google.com".to_string()]);
        let ssh = r#"{"v":1,"kind":"ssh","fields":{"host":"srv.example.com","password":"pw","privateKey":"KEY"}}"#;
        assert_eq!(index_fields("ssh", ssh), ("srv.example.com".into(), vec!["srv.example.com".into()]));
        let api = r#"{"v":1,"kind":"secret","fields":{"service":"OpenAI","key":"sk-123"}}"#;
        assert_eq!(index_fields("secret", api), ("OpenAI".into(), vec!["OpenAI".into()]));
        assert_eq!(index_fields("md", "# hunter2"), (String::new(), vec![]));
        assert_eq!(index_fields("login", "{broken"), (String::new(), vec![]));
        let wifi = r#"{"v":1,"kind":"wifi","fields":{"ssid":"HomeNet","password":"wifipass"}}"#;
        assert_eq!(index_fields("wifi", wifi), ("HomeNet".into(), vec!["HomeNet".into()]));
        let codes = r#"{"v":1,"kind":"codes","service":"GitHub","codes":[{"code":"abcd-1234","used":false}]}"#;
        assert_eq!(index_fields("codes", codes), ("GitHub".into(), vec!["GitHub".into()]));
        let all = format!("{:?}", [index_fields("login", login), index_fields("ssh", ssh), index_fields("secret", api), index_fields("wifi", wifi), index_fields("codes", codes)]);
        for secret in ["hunter2", "ABC\"", "pw\"", "KEY", "sk-123", "\"me\"", "wifipass", "abcd-1234"] {
            assert!(!all.contains(secret), "index leaked {secret}");
        }
    }

    #[test]
    fn totp_matches_rfc6238_vectors() {
        // RFC 6238 appendix B (SHA-1 seed "12345678901234567890"), last 6 digits.
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        for (t, code) in [(59u64, "287082"), (1111111109, "081804"), (1111111111, "050471"),
                          (1234567890, "005924"), (2000000000, "279037"), (20000000000, "353130")] {
            assert_eq!(totp_at(secret, t).as_deref(), Some(code), "t={t}");
        }
        // Spaces, dashes, padding and lower case are tolerated, like the frontend's decoder.
        assert_eq!(totp_at("gezd gnbv-gy3t qojq gezd gnbv gy3t qojq==", 59).as_deref(), Some("287082"));
        assert_eq!(totp_at("", 59), None);
        assert_eq!(totp_at("not base32!", 59), None);
        assert_eq!(totp_at("1", 59), None); // '1' isn't in the alphabet
    }

    #[test]
    fn totp_remaining_counts_down_per_step() {
        assert_eq!(totp_remaining(0), 30);
        assert_eq!(totp_remaining(1), 29);
        assert_eq!(totp_remaining(29), 1);
        assert_eq!(totp_remaining(30), 30);
    }

    #[test]
    fn totp_now_returns_only_the_code() {
        let login = r#"{"v":1,"kind":"login","title":"G","username":"me","password":"hunter2","totp":"GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"}"#;
        let now = totp_now("login", login, 59_000).unwrap();
        assert_eq!(now, TotpNow { code: "287082".into(), remaining: 1, period: 30 });
        let json = serde_json::to_string(&now).unwrap();
        for leak in ["hunter2", "GEZDGNBV", "\"me\""] {
            assert!(!json.contains(leak), "totp reply leaked {leak}");
        }
        // Next step: a new code with the full window left.
        let next = totp_now("login", login, 60_000).unwrap();
        assert_eq!(next.remaining, 30);
        assert_ne!(next.code, now.code);
        // No / blank / broken secret, other kinds, broken JSON.
        assert_eq!(totp_now("login", r#"{"totp":""}"#, 0), None);
        assert_eq!(totp_now("login", r#"{"totp":"   "}"#, 0), None);
        assert_eq!(totp_now("login", r#"{"totp":"!!"}"#, 0), None);
        assert_eq!(totp_now("login", r#"{"password":"x"}"#, 0), None);
        assert_eq!(totp_now("login", "{broken", 0), None);
        assert_eq!(totp_now("secret", r#"{"totp":"GEZDGNBVGY3TQOJQ"}"#, 0), None);
    }

    #[test]
    fn index_flags_totp_without_the_secret() {
        let with = r#"{"kind":"login","url":"https://google.com","totp":"JBSWY3DPEHPK3PXP"}"#;
        assert!(has_totp("login", with));
        assert!(!has_totp("login", r#"{"kind":"login","totp":""}"#));
        assert!(!has_totp("login", r#"{"kind":"login","totp":"??"}"#));
        assert!(!has_totp("login", r#"{"kind":"login"}"#));
        assert!(!has_totp("md", with));
        let item = IndexItem {
            rel: "G.nqv".into(), ext: "login".into(), tags: vec![], starred: false, updated: 0,
            host: "google.com".into(), urls: vec![], totp: has_totp("login", with),
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"totp\":true"));
        assert!(!json.contains("JBSWY3DP"));
    }

    #[test]
    fn show_waits_for_the_page_then_times_out() {
        assert_eq!(show_step(true, 0, READY_WAIT_MS), ShowStep::Show { ready: true });
        assert_eq!(show_step(true, 99_999, READY_WAIT_MS), ShowStep::Show { ready: true });
        assert_eq!(show_step(false, 0, READY_WAIT_MS), ShowStep::Wait);
        assert_eq!(show_step(false, READY_WAIT_MS - 1, READY_WAIT_MS), ShowStep::Wait);
        // Not ready in time: shown anyway (dark background + the page's loading state).
        assert_eq!(show_step(false, READY_WAIT_MS, READY_WAIT_MS), ShowStep::Show { ready: false });
        assert!(READY_WAIT_MS <= 2000, "the hotkey must feel instant");
    }

    #[test]
    fn focus_loss_hides_only_a_visible_window() {
        assert!(hide_on_blur(false, true)); // outside click / app switch
        assert!(!hide_on_blur(true, true)); // gained the focus
        assert!(!hide_on_blur(false, false)); // already hidden (copy / open / unlock hid it first)
        assert!(!hide_on_blur(true, false));
    }

    #[test]
    fn a_silent_page_is_reloaded_only_if_it_was_ready() {
        assert!(needs_reload(true, false)); // was listening, didn't answer `shown`: JS is dead
        assert!(!needs_reload(true, true));
        assert!(!needs_reload(false, false)); // still loading: a reload would only restart it
        assert!(!needs_reload(false, true));
    }

    #[test]
    fn guard_hides_a_window_nobody_asked_for() {
        // Visible without a hotkey / reopen show (stale show, OS or WebView2 quirk, reload): always hidden,
        // whoever holds the foreground and however long ago the last real show was.
        for fg in [Foreground::Ours, Foreground::Other, Foreground::None] {
            for since in [0, SHOW_GRACE_MS, 99_999] {
                assert_eq!(guard_step(false, true, fg, since, 0), GuardAction::Hide, "{fg:?} {since}");
            }
        }
        // Hidden: nothing to do, open or not.
        for open in [false, true] {
            assert_eq!(guard_step(open, false, Foreground::Other, 99_999, 99_999), GuardAction::Nothing);
        }
    }

    #[test]
    fn guard_closes_an_open_window_that_lost_the_foreground() {
        // Ours (or a hand-over with no foreground): stays.
        assert_eq!(guard_step(true, true, Foreground::Ours, 99_999, 0), GuardAction::Nothing);
        assert_eq!(guard_step(true, true, Foreground::None, 99_999, 0), GuardAction::Nothing);
        // Right after the show the activation may still be on its way: ask for the focus again.
        assert_eq!(guard_step(true, true, Foreground::Other, 0, 0), GuardAction::Refocus);
        assert_eq!(guard_step(true, true, Foreground::Other, SHOW_GRACE_MS - 1, 900), GuardAction::Refocus);
        // Afterwards another window in front = the user clicked / switched away: hide (once confirmed).
        assert_eq!(guard_step(true, true, Foreground::Other, SHOW_GRACE_MS, 0), GuardAction::Nothing);
        assert_eq!(guard_step(true, true, Foreground::Other, SHOW_GRACE_MS, BLUR_CONFIRM_MS - 1), GuardAction::Nothing);
        assert_eq!(guard_step(true, true, Foreground::Other, SHOW_GRACE_MS, BLUR_CONFIRM_MS), GuardAction::Hide);
        assert_eq!(guard_step(true, true, Foreground::Other, 99_999, 99_999), GuardAction::Hide);
        assert!(SHOW_GRACE_MS + BLUR_CONFIRM_MS <= 1500, "a never-focused window must not linger");
    }

    #[test]
    fn reopen_only_right_after_the_popups_own_unlock() {
        assert!(!reopen_allowed(0, 10)); // the popup never asked (stale waiter, other unlock flow)
        assert!(reopen_allowed(1_000, 1_000));
        assert!(reopen_allowed(1_000, 1_000 + REOPEN_WINDOW_MS));
        assert!(!reopen_allowed(1_000, 1_001 + REOPEN_WINDOW_MS)); // too late: the user moved on
        assert!(!reopen_allowed(5_000, 4_000)); // clock sanity
    }

    #[test]
    fn mono_clock_never_reads_as_never() {
        assert!(mono_ms() >= 1);
        let a = mono_ms();
        assert!(mono_ms() >= a);
    }

    #[test]
    fn identity_entries_are_found_by_title_only() {
        let id = r#"{"v":1,"kind":"identity","title":"Home","fields":{"name":"Asha Rao","email":"a@b.in","city":"Pune"}}"#;
        assert_eq!(index_fields("identity", id), (String::new(), vec![]));
    }
}
