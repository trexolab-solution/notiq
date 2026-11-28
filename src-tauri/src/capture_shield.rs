//! Capture shield (0.9.1): keeps vault content out of screenshots, screen recordings and screen
//! sharing. Tauri's `set_content_protected` sets `WDA_EXCLUDEFROMCAPTURE` through
//! `SetWindowDisplayAffinity` on Windows, so a capture shows the window as a black rectangle (the
//! user's own screen share too).
//!
//! * The mode lives in `<app-data>/capture_shield.json` (the Rust side can't read the WebView's
//!   localStorage and windows are created here), written through `capture_shield_set`.
//! * Main + quick-search window: protected while the vault is unlocked (`WhileUnlocked`, default)
//!   or always (`Always`). Autofill prompt: protected unless `Off`.
//! * [`refresh`] re-applies everything; it runs on every lock/unlock and after a window is created.
//! * "Off for N minutes": a temporary `Off` on top of the saved mode, e.g. to show Notiq in a screen share.
//!   It ends by itself and is cleared whenever a mode is chosen explicitly. It is never saved, so a restart
//!   brings the protection back. Asked for while the saved mode is `Off`, the saved mode becomes the default,
//!   so that there is protection to come back to.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const CONFIG_FILE: &str = "capture_shield.json";
const MAIN_LABEL: &str = "main";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    WhileUnlocked,
    Always,
    Off,
}

impl Mode {
    fn to_u8(self) -> u8 {
        match self { Mode::WhileUnlocked => 0, Mode::Always => 1, Mode::Off => 2 }
    }
    fn from_u8(n: u8) -> Mode {
        match n { 1 => Mode::Always, 2 => Mode::Off, _ => Mode::WhileUnlocked }
    }
}

/// Which window is asking.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// The main window and quick search: both can show vault items while unlocked.
    Vault,
    /// The autofill prompt: only ever shows vault data.
    Prompt,
}

/// Whether a window of `kind` must be hidden from capture (pure).
pub fn should_protect(mode: Mode, unlocked: bool, kind: Kind) -> bool {
    match (mode, kind) {
        (Mode::Off, _) => false,
        (Mode::Always, _) => true,
        (Mode::WhileUnlocked, Kind::Prompt) => true,
        (Mode::WhileUnlocked, Kind::Vault) => unlocked,
    }
}

/// Tolerant parse: anything unreadable means the default mode.
pub fn parse_mode(s: &str) -> Mode {
    serde_json::from_str::<Mode>(s.trim()).unwrap_or_default()
}

/// What is saved in `capture_shield.json`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    mode: Mode,
}

/// Tolerant parse of the saved file. The first versions stored just the mode as a JSON string, which still
/// reads; fields this version doesn't know are ignored; anything unreadable means the defaults.
fn parse_config(s: &str) -> Config {
    let s = s.trim();
    serde_json::from_str::<Config>(s)
        .or_else(|_| serde_json::from_str::<Mode>(s).map(|mode| Config { mode }))
        .unwrap_or_default()
}

/// The mode that applies right now: an "Off for N minutes" period that has not ended yet means `Off` (pure).
pub fn effective_mode(saved: Mode, off_until_ms: u64, now_ms: u64) -> Mode {
    if off_until_ms > now_ms { Mode::Off } else { saved }
}

/// The saved mode to keep when a timed "Off" starts: one that protects again afterwards (pure).
fn mode_after_pause(saved: Mode) -> Mode {
    if saved == Mode::Off { Mode::default() } else { saved }
}

/// Longest period the UI may ask for.
const MAX_OFF_MINUTES: u32 = 20;

static MODE: AtomicU8 = AtomicU8::new(0);
/// End of the current "Off for N minutes" period, in ms since the epoch; 0 = none. Memory only.
static OFF_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn saved_mode() -> Mode { Mode::from_u8(MODE.load(Ordering::Acquire)) }

fn mode() -> Mode { effective_mode(saved_mode(), OFF_UNTIL.load(Ordering::Acquire), now_ms()) }

fn persist(app: &AppHandle) -> Result<(), String> {
    let json = serde_json::to_string(&Config { mode: saved_mode() }).map_err(|e| e.to_string())?;
    crate::vault::atomic_write(&config_path(app)?, json.as_bytes())
}

/// Ends the period by itself: waits (re-checking the wall clock, so a sleeping PC is handled) until `until`,
/// then protects again, unless the user changed things in the meantime.
fn watch_off(app: AppHandle, until: u64) {
    std::thread::spawn(move || {
        while OFF_UNTIL.load(Ordering::Acquire) == until && now_ms() < until {
            std::thread::sleep(Duration::from_secs(2));
        }
        if OFF_UNTIL.compare_exchange(until, 0, Ordering::AcqRel, Ordering::Acquire).is_ok() {
            refresh(&app);
            let _ = tauri::Emitter::emit(&app, "capture-shield-changed", ());
        }
    });
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(CONFIG_FILE))
}

/// What was last applied to each window: `(window handle, protected)`. Re-setting the display affinity
/// makes Windows rebuild the window's surface, which a hidden WebView2 window should not go through on
/// every lock / unlock, so a call that would change nothing is skipped. The handle tells a re-created
/// window (new handle) from the one that already has the setting.
static APPLIED: std::sync::Mutex<Vec<(String, isize, bool)>> = std::sync::Mutex::new(Vec::new());

/// Whether `protect` still has to be applied to the window `handle` (pure). A handle of 0 (unknown)
/// always applies.
pub fn needs_apply(last: Option<(isize, bool)>, handle: isize, protect: bool) -> bool {
    handle == 0 || last != Some((handle, protect))
}

fn apply_to(app: &AppHandle, label: &str, protect: bool) {
    let Some(w) = app.get_webview_window(label) else { return };
    #[cfg(windows)]
    let handle = w.hwnd().map(|h| h.0 as isize).unwrap_or(0);
    #[cfg(not(windows))]
    let handle = 0isize;
    let mut applied = APPLIED.lock().unwrap_or_else(|e| e.into_inner());
    let last = applied.iter().find(|(l, _, _)| l == label).map(|(_, h, p)| (*h, *p));
    if !needs_apply(last, handle, protect) {
        return;
    }
    crate::window_log::log(&format!("capture shield: {label} protected={protect} visible={:?}", w.is_visible().ok()));
    let _ = w.set_content_protected(protect);
    applied.retain(|(l, _, _)| l != label);
    applied.push((label.to_string(), handle, protect));
}

/// Drops what is remembered about a window that was destroyed.
pub fn forget(label: &str) {
    APPLIED.lock().unwrap_or_else(|e| e.into_inner()).retain(|(l, _, _)| l != label);
}

/// Re-applies the display affinity of every window from the current mode and lock state.
pub fn refresh(app: &AppHandle) {
    let m = mode();
    let unlocked = app.state::<crate::vault::VaultState>().is_unlocked();
    let vault = should_protect(m, unlocked, Kind::Vault);
    apply_to(app, MAIN_LABEL, vault);
    apply_to(app, crate::quick_search::WINDOW_LABEL, vault);
    apply_to(app, crate::autofill::PROMPT_LABEL, should_protect(m, unlocked, Kind::Prompt));
}

/// Loads the saved mode and applies it. Call once at startup.
pub fn start(app: &AppHandle) {
    let cfg = config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| parse_config(&s))
        .unwrap_or_default();
    MODE.store(cfg.mode.to_u8(), Ordering::Release);
    refresh(app);
}

/// The saved mode (not the temporary "Off for N minutes"; see `capture_shield_status`).
#[tauri::command]
pub fn capture_shield_get() -> Mode { saved_mode() }

/// Saved mode plus the end of a running "Off for N minutes" period (ms since the epoch), for the settings row.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    mode: Mode,
    off_until_ms: Option<u64>,
}

#[tauri::command]
pub fn capture_shield_status() -> Status {
    let until = OFF_UNTIL.load(Ordering::Acquire);
    Status { mode: saved_mode(), off_until_ms: if until > now_ms() { Some(until) } else { None } }
}

/// Choosing a mode explicitly also ends any "Off for N minutes".
#[tauri::command]
pub fn capture_shield_set(app: AppHandle, mode: Mode) -> Result<(), String> {
    MODE.store(mode.to_u8(), Ordering::Release);
    OFF_UNTIL.store(0, Ordering::Release);
    persist(&app)?;
    refresh(&app);
    Ok(())
}

/// Stops hiding Notiq from capture for `minutes`, then the saved mode applies again.
#[tauri::command]
pub fn capture_shield_off_for(app: AppHandle, minutes: u32) -> Result<(), String> {
    if minutes == 0 || minutes > MAX_OFF_MINUTES {
        return Err(format!("Choose between 1 and {MAX_OFF_MINUTES} minutes"));
    }
    MODE.store(mode_after_pause(saved_mode()).to_u8(), Ordering::Release);
    persist(&app)?;
    let until = now_ms() + u64::from(minutes) * 60_000;
    OFF_UNTIL.store(until, Ordering::Release);
    refresh(&app);
    watch_off(app, until);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unchanged_setting_is_not_applied_again() {
        assert!(needs_apply(None, 7, true)); // first time
        assert!(!needs_apply(Some((7, true)), 7, true)); // same window, same value
        assert!(needs_apply(Some((7, true)), 7, false)); // value changed
        assert!(needs_apply(Some((7, true)), 8, true)); // window was re-created
        assert!(needs_apply(Some((0, true)), 0, true)); // handle unknown: always apply
    }

    #[test]
    fn off_never_protects() {
        for unlocked in [false, true] {
            for k in [Kind::Vault, Kind::Prompt] {
                assert!(!should_protect(Mode::Off, unlocked, k));
            }
        }
    }

    #[test]
    fn always_protects_everything() {
        for unlocked in [false, true] {
            for k in [Kind::Vault, Kind::Prompt] {
                assert!(should_protect(Mode::Always, unlocked, k));
            }
        }
    }

    #[test]
    fn while_unlocked_follows_the_lock_state_except_for_the_prompt() {
        assert!(should_protect(Mode::WhileUnlocked, true, Kind::Vault));
        assert!(!should_protect(Mode::WhileUnlocked, false, Kind::Vault));
        assert!(should_protect(Mode::WhileUnlocked, true, Kind::Prompt));
        assert!(should_protect(Mode::WhileUnlocked, false, Kind::Prompt));
    }

    #[test]
    fn mode_parse_is_tolerant() {
        assert_eq!(parse_mode("\"always\""), Mode::Always);
        assert_eq!(parse_mode("\"off\"\n"), Mode::Off);
        assert_eq!(parse_mode("\"while_unlocked\""), Mode::WhileUnlocked);
        assert_eq!(parse_mode("garbage"), Mode::WhileUnlocked);
        assert_eq!(parse_mode(""), Mode::WhileUnlocked);
    }

    #[test]
    fn a_running_off_period_means_off_and_an_ended_one_does_not() {
        assert_eq!(effective_mode(Mode::Always, 2_000, 1_000), Mode::Off);
        assert_eq!(effective_mode(Mode::Always, 1_000, 1_000), Mode::Always);
        assert_eq!(effective_mode(Mode::WhileUnlocked, 0, 1_000), Mode::WhileUnlocked);
    }

    #[test]
    fn a_timed_off_always_has_protection_to_come_back_to() {
        assert_eq!(mode_after_pause(Mode::Off), Mode::WhileUnlocked);
        assert_eq!(mode_after_pause(Mode::Always), Mode::Always);
        assert_eq!(mode_after_pause(Mode::WhileUnlocked), Mode::WhileUnlocked);
    }

    #[test]
    fn config_reads_old_files_and_never_restores_a_timed_period() {
        assert_eq!(parse_config(r#""always""#), Config { mode: Mode::Always });
        assert_eq!(parse_config(r#"{"mode":"off","hide_until_ms":123}"#), Config { mode: Mode::Off });
        assert_eq!(parse_config(r#"{"mode":"always"}"#), Config { mode: Mode::Always });
        assert_eq!(parse_config("garbage"), Config::default());
    }

    #[test]
    fn mode_round_trips_through_u8() {
        for m in [Mode::WhileUnlocked, Mode::Always, Mode::Off] {
            assert_eq!(Mode::from_u8(m.to_u8()), m);
        }
    }
}
