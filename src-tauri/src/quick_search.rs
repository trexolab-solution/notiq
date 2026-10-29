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
const OPEN_EVENT: &str = "quick-search:open";
const UNLOCK_EVENT: &str = "quick-search:unlock";

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
    }
    #[derive(Deserialize, Default)]
    struct Structured {
        #[serde(default)]
        fields: Fields,
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
        _ => (String::new(), vec![]),
    }
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
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
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

// ─── window ──────────────────────────────────────────────────────────────────

#[cfg(desktop)]
fn on_hotkey(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
            restore_foreground();
            return;
        }
    }
    remember_foreground(app);
    // Creating a webview from the event-loop thread can deadlock on Windows; do it off-thread.
    let app = app.clone();
    std::thread::spawn(move || show_window(&app));
}

#[cfg(desktop)]
fn show_window(app: &AppHandle) {
    let w = match app.get_webview_window(WINDOW_LABEL) {
        Some(w) => w,
        None => {
            let built = tauri::WebviewWindowBuilder::new(
                app,
                WINDOW_LABEL,
                tauri::WebviewUrl::App("index.html#/quick-search".into()),
            )
            .title(if crate::profile::IS_DEV { "Notiq Dev Quick Search" } else { "Notiq Quick Search" })
            .inner_size(560.0, 400.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .shadow(true)
            .background_color(tauri::window::Color(15, 23, 42, 255))
            .visible(false)
            .center()
            .build();
            match built {
                Ok(w) => w,
                Err(e) => {
                    eprintln!("quick_search: cannot create window: {e}");
                    return;
                }
            }
        }
    };
    let _ = w.center();
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = app.emit_to(WINDOW_LABEL, SHOWN_EVENT, ());
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
        if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
            let _ = w.hide();
        }
    }
    Ok(status(next))
}

/// Hides the quick window; `restore` hands the focus back to the window that was active before.
#[tauri::command]
pub fn quick_search_hide(app: AppHandle, restore: bool) {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.hide();
    }
    if restore {
        restore_foreground();
    } else {
        #[cfg(windows)]
        PREV_FOREGROUND.store(0, std::sync::atomic::Ordering::Release);
    }
}

/// Brings the main window forward and asks it to open an entry (`rel`) or the unlock dialog.
#[tauri::command]
pub fn quick_search_show_main(app: AppHandle, action: String, rel: Option<String>) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(WINDOW_LABEL) {
        let _ = w.hide();
    }
    // After an unlock the popup comes back (`quick_search_reopen`) and a copy should still return
    // the focus to the original app; opening an entry ends the quick-search session.
    #[cfg(windows)]
    if action != "unlock" {
        PREV_FOREGROUND.store(0, std::sync::atomic::Ordering::Release);
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
#[tauri::command]
pub fn quick_search_reopen(app: AppHandle) {
    #[cfg(desktop)]
    std::thread::spawn(move || show_window(&app));
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
                    updated: e.updated, host, urls,
                }
            })
            .collect();
        Ok((items, false))
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
        let all = format!("{:?}", [index_fields("login", login), index_fields("ssh", ssh), index_fields("secret", api)]);
        for secret in ["hunter2", "ABC\"", "pw\"", "KEY", "sk-123", "\"me\""] {
            assert!(!all.contains(secret), "index leaked {secret}");
        }
    }
}
