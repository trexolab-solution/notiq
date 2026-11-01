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

use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, Ordering};

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

static MODE: AtomicU8 = AtomicU8::new(0);

fn mode() -> Mode { Mode::from_u8(MODE.load(Ordering::Acquire)) }

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(CONFIG_FILE))
}

fn apply_to(app: &AppHandle, label: &str, protect: bool) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_content_protected(protect);
    }
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
    let m = config_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|s| parse_mode(&s))
        .unwrap_or_default();
    MODE.store(m.to_u8(), Ordering::Release);
    refresh(app);
}

#[tauri::command]
pub fn capture_shield_get() -> Mode { mode() }

#[tauri::command]
pub fn capture_shield_set(app: AppHandle, mode: Mode) -> Result<(), String> {
    let json = serde_json::to_string(&mode).map_err(|e| e.to_string())?;
    crate::vault::atomic_write(&config_path(&app)?, json.as_bytes())?;
    MODE.store(mode.to_u8(), Ordering::Release);
    refresh(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn mode_round_trips_through_u8() {
        for m in [Mode::WhileUnlocked, Mode::Always, Mode::Off] {
            assert_eq!(Mode::from_u8(m.to_u8()), m);
        }
    }
}
