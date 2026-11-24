//! A small log of window events (the autofill prompt and the quick search window being created, shown, hidden or
//! repainted), kept in the app data folder as `window.log`. A window that appears on its own is rare and leaves
//! no trace otherwise (a release build has no console), so this tells afterwards what put it there.
//! It holds window names and counts only, never a note, a login or a host.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const FILE: &str = "window.log";
/// The log is cut to its newer half when it grows past this.
const MAX_BYTES: u64 = 64 * 1024;

static DIR: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());

/// Tells the log where the app data folder is (once, at startup).
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

/// The newer half of `text`, starting at a line boundary (pure).
pub fn newer_half(text: &str) -> &str {
    let from = text.len() / 2;
    let from = (from..text.len()).find(|&i| text.is_char_boundary(i)).unwrap_or(text.len());
    match text[from..].find('\n') {
        Some(n) => &text[from + n + 1..],
        None => "",
    }
}

/// `[window] message`, to the console and to the log file.
pub fn log(message: &str) {
    eprintln!("[window] {message}");
    let Some(dir) = DIR.get() else { return };
    let _one_at_a_time = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = dir.join(FILE);
    if std::fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        if let Ok(old) = std::fs::read_to_string(&path) {
            let _ = std::fs::write(&path, newer_half(&old));
        }
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (h, m, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        // UTC clock time of day plus the day number: enough to line an entry up with when the user saw it.
        let _ = writeln!(f, "{} {h:02}:{m:02}:{s:02}Z {message}", secs / 86_400);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newer_half_starts_at_a_whole_line() {
        let text = "one\ntwo\nthree\nfour\n";
        let kept = newer_half(text);
        assert!(text.ends_with(kept));
        assert!(kept.starts_with("three") || kept.starts_with("four"));
        assert_eq!(newer_half("no newline at all"), "");
        assert_eq!(newer_half(""), "");
        assert_eq!(newer_half("ééééé\nxy\n"), "xy\n");
    }
}
