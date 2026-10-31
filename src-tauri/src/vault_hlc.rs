//! Vault sync foundation: hybrid logical clock stamps and the per-device id.
//!
//! Pure (no Tauri). A stamp orders changes across devices: `(wall_ms, counter, device)`
//! compared lexicographically, so the same entry edited on two machines has one winner
//! everywhere. The device id is random per installation and lives in its own file in the
//! app-data folder, never inside `vault.nqdb` and never in `vault.json` (which will sync).

use std::{fs, path::Path};

use rand::RngCore;
use serde::{Deserialize, Serialize};

/// File in the app-data folder that holds this installation's device id.
pub const DEVICE_FILE: &str = "vault-device.id";
/// Hex chars in a device id (16 random bytes).
pub const DEVICE_ID_LEN: usize = 32;

/// A hybrid logical clock stamp. `Ord` = (wall, counter, device); `Default` = (0, 0, "").
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(default)]
pub struct Hlc {
    /// Unix ms (never below the last stamp this clock issued or observed).
    pub wall: u64,
    /// Orders stamps issued within the same `wall` millisecond.
    pub counter: u32,
    /// Device that issued the stamp ("" for stamps made up while migrating old data).
    pub device: String,
}

impl Hlc {
    /// Legacy stamp for data written before stamps existed.
    pub fn legacy(wall: u64) -> Hlc {
        Hlc { wall, counter: 0, device: String::new() }
    }

    pub fn is_zero(&self) -> bool {
        *self == Hlc::default()
    }

    /// The stamp to issue after `self` (the last issued/observed one): `wall = max(now, last.wall)`;
    /// the same wall bumps the counter, a later wall resets it.
    pub fn next(&self, now: u64, device: &str) -> Hlc {
        let wall = now.max(self.wall);
        let counter = if wall == self.wall { self.counter.saturating_add(1) } else { 0 };
        Hlc { wall, counter, device: device.into() }
    }

    /// Raises this clock to `seen` (wall, counter) so stamps issued afterwards are higher.
    pub fn observe(&mut self, seen: &Hlc) {
        if (seen.wall, seen.counter) > (self.wall, self.counter) {
            *self = seen.clone();
        }
    }
}

/// A removal register (trash or permanent delete). `over` = the entry's stamp when it was removed
/// (the version the remover had seen); `at` = fresh stamp of the removal itself (retention, display).
/// It applies only while `over >= stamp`, so a later edit (or restore) wins over it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(default)]
pub struct Removal {
    pub over: Hlc,
    pub at: Hlc,
}

impl Removal {
    pub fn applies_to(&self, stamp: &Hlc) -> bool {
        self.over >= *stamp
    }
}

/// 32 lowercase hex chars.
pub fn valid_device_id(s: &str) -> bool {
    s.len() == DEVICE_ID_LEN && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn new_device_id() -> String {
    let mut b = [0u8; DEVICE_ID_LEN / 2];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// This installation's device id from `<dir>/vault-device.id`, created (atomically) when the file
/// is missing or doesn't hold a valid id.
pub fn load_or_create_device(dir: &Path) -> Result<String, String> {
    let path = dir.join(DEVICE_FILE);
    if let Ok(s) = fs::read_to_string(&path) {
        let s = s.trim();
        if valid_device_id(s) { return Ok(s.to_string()); }
    }
    let id = new_device_id();
    crate::vault::atomic_write(&path, id.as_bytes())?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(wall: u64, counter: u32, device: &str) -> Hlc {
        Hlc { wall, counter, device: device.into() }
    }

    #[test]
    fn ordering_is_wall_then_counter_then_device() {
        assert!(h(1, 9, "z") < h(2, 0, "a"));
        assert!(h(2, 0, "z") < h(2, 1, "a"));
        assert!(h(2, 1, "a") < h(2, 1, "b"));
        assert_eq!(Hlc::default(), h(0, 0, ""));
        assert!(Hlc::default().is_zero() && !Hlc::legacy(5).is_zero());
        assert!(Hlc::default() < Hlc::legacy(1));
    }

    #[test]
    fn issued_stamps_are_strictly_increasing_even_when_the_clock_goes_back() {
        let mut last = Hlc::default();
        let mut seen = vec![];
        for now in [100, 100, 100, 50, 0, 101, 101, 99] {
            let s = last.next(now, "d");
            assert!(s > last, "{s:?} > {last:?}");
            last = s.clone();
            seen.push(s);
        }
        assert_eq!((seen[0].wall, seen[0].counter), (100, 0));
        assert_eq!((seen[2].wall, seen[2].counter), (100, 2));
        assert_eq!((seen[4].wall, seen[4].counter), (100, 4), "a clock going back keeps the wall");
        assert_eq!((seen[5].wall, seen[5].counter), (101, 0), "a later wall resets the counter");
        assert_eq!((seen[7].wall, seen[7].counter), (101, 2));
        assert!(seen.iter().all(|s| s.device == "d"));
    }

    #[test]
    fn observe_raises_the_clock_past_remote_stamps() {
        let mut c = h(100, 3, "me");
        c.observe(&h(90, 50, "other"));
        assert_eq!(c, h(100, 3, "me"), "older stamps are ignored");
        c.observe(&h(500, 7, "other"));
        let s = c.next(200, "me");
        assert!(s > h(500, 7, "other") && s.device == "me");
        assert_eq!((s.wall, s.counter), (500, 8));
        // same (wall, counter) from another device: the next local stamp still beats it
        let mut c = h(10, 1, "a");
        c.observe(&h(10, 1, "zzz"));
        assert!(c.next(0, "a") > h(10, 1, "zzz"));
    }

    #[test]
    fn removal_applies_only_to_versions_it_had_seen() {
        let r = Removal { over: h(10, 0, "a"), at: h(20, 0, "a") };
        assert!(r.applies_to(&h(10, 0, "a")) && r.applies_to(&h(9, 5, "b")));
        assert!(!r.applies_to(&h(10, 1, "a")) && !r.applies_to(&h(11, 0, "")));
    }

    #[test]
    fn device_id_file_is_created_once_and_reused() {
        let dir = std::env::temp_dir().join(format!("nq-device-{}", new_device_id()));
        let a = load_or_create_device(&dir).unwrap();
        assert!(valid_device_id(&a));
        assert_eq!(fs::read_to_string(dir.join(DEVICE_FILE)).unwrap(), a);
        assert_eq!(load_or_create_device(&dir).unwrap(), a, "survives a restart");
        // a damaged file is replaced with a fresh id
        fs::write(dir.join(DEVICE_FILE), "not-an-id").unwrap();
        let b = load_or_create_device(&dir).unwrap();
        assert!(valid_device_id(&b) && b != a);
        assert_eq!(load_or_create_device(&dir).unwrap(), b);
        // trailing whitespace (hand-edited file) is fine
        fs::write(dir.join(DEVICE_FILE), format!("{b}\r\n")).unwrap();
        assert_eq!(load_or_create_device(&dir).unwrap(), b);
        fs::remove_dir_all(&dir).ok();
    }
}
