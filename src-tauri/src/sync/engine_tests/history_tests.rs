//! Drive version history (`sync::history`) against `InMemoryProvider`: daily copies, retention,
//! checkpoints, listing and "Restore vault from a date".

use std::collections::{BTreeMap, HashMap};

use async_trait::async_trait;

use super::*;
use crate::sync::history::{self, RestorePoint, KEEP_DAYS, MAX_CHECKPOINTS_PER_DEVICE, RESTORE_BACKUP_REASON};
use crate::sync::provider::{Capabilities, RemoteObject};

const DAY: u64 = 86_400_000;

/// Noon UTC `days` days from today (the cycle's clock; entry stamps still use the real clock).
/// Fixed for the whole test run, so a test crossing midnight doesn't change its days.
fn day(days: u64) -> u64 {
    static BASE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *BASE.get_or_init(|| crate::vault_db::now_ms() / DAY * DAY + DAY / 2) + days * DAY
}

fn ctx_at<'a>(d: &Device, p: &'a dyn StorageProvider, now: u64) -> Ctx<'a> {
    Ctx::new(p, &d.v.key, &d.v.vault_id, d.id, &d.name, now)
}

fn sync_at(d: &mut Device, p: &dyn StorageProvider, now: u64) -> Outcome {
    let ctx = Ctx::new(p, &d.v.key, &d.v.vault_id, d.id, &d.name, now);
    ok(block_on(sync_once(&ctx, &d.v, &mut d.st, Mode::Full)))
}

fn history_of(p: &InMemoryProvider, dev: &str) -> Vec<String> {
    list_now(p, &format!("history/{dev}/")).into_iter().map(|o| o.name).collect()
}

fn points(d: &Device, p: &dyn StorageProvider) -> Vec<RestorePoint> {
    let keys = SyncKeys::derive(&d.v.key, &d.v.vault_id);
    let mut known = d.st.devices.clone();
    block_on(history::list_points(p, Some(&keys), &mut known, d.id, &d.name)).unwrap().0
}

fn restore(d: &Device, p: &dyn StorageProvider, id: &str) -> Result<history::RestoreSummary, SyncError> {
    let ctx = ctx_at(d, p, crate::vault_db::now_ms());
    block_on(history::restore(&ctx, &d.v, id))
}

fn wipe(d: &mut Device, path: &str) {
    d.edit(|db| {
        db.trash(path).unwrap();
        db.empty_trash();
    });
}

#[test]
fn one_daily_copy_per_device_per_day() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("n.nqv", "morning");
    sync_at(&mut a, &p, day(0));
    let today = history::daily_name(A, history::day_of(day(0)));
    assert_eq!(history_of(&p, A), vec![today.clone()]);
    // The copy is the sealed snapshot itself: identical bytes, never plaintext.
    let copy = p.raw(&today).unwrap();
    assert_eq!(copy, p.raw(&seal::device_object(A)).unwrap());
    assert!(!copy.windows(7).any(|w| w == b"morning"));

    // More uploads the same day keep the first copy of the day.
    a.put("n.nqv", "evening");
    sync_at(&mut a, &p, day(0) + 1000);
    assert_eq!(history_of(&p, A), vec![today.clone()]);
    assert_eq!(p.version_count(&today), 1, "never overwritten");
    // Nothing to upload → no history work at all.
    p.reset_calls();
    sync_at(&mut a, &p, day(0) + 2000);
    assert_eq!((p.calls().put, p.calls().delete), (0, 0));

    // The next day gets its own copy; a second device keeps its own.
    a.put("n.nqv", "next day");
    sync_at(&mut a, &p, day(1));
    assert_eq!(history_of(&p, A).len(), 2);
    let mut b = join(&p, B, "Desk", PW).unwrap();
    b.put("b.nqv", "from B");
    sync_at(&mut b, &p, day(1));
    assert!(history_of(&p, B).contains(&history::daily_name(B, history::day_of(day(1)))));
    assert!(history_of(&p, B).len() <= 2, "joined (today) + day 1");
}

#[test]
fn old_copies_and_extra_checkpoints_are_cleaned_up() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    // Something that isn't ours under history/ is never touched.
    block_on(p.put(&format!("history/{A}/readme.txt"), b"x")).unwrap();
    for d in 0..(KEEP_DAYS + 6) {
        a.put("n.nqv", &format!("day {d}"));
        sync_at(&mut a, &p, day(d));
    }
    let names = history_of(&p, A);
    let dailies: Vec<&String> = names.iter().filter(|n| n.ends_with(".nqs")).collect();
    assert_eq!(dailies.len() as u64, KEEP_DAYS + 1, "today + {KEEP_DAYS} days back");
    let last = KEEP_DAYS + 5;
    assert!(!names.contains(&history::daily_name(A, history::day_of(day(last - KEEP_DAYS - 1)))));
    assert!(names.contains(&history::daily_name(A, history::day_of(day(last - KEEP_DAYS)))));
    assert!(names.contains(&format!("history/{A}/readme.txt")));

    // Checkpoints are capped per device, oldest first.
    let now = day(last);
    for i in 0..(MAX_CHECKPOINTS_PER_DEVICE as u64 + 3) {
        let ctx = ctx_at(&a, &p, now + i * 1000);
        assert!(block_on(history::checkpoint(&ctx, "before-mass-delete")).unwrap().is_some());
    }
    let cps: Vec<String> = history_of(&p, A).into_iter().filter(|n| n.contains("-before-mass-delete")).collect();
    assert_eq!(cps.len(), MAX_CHECKPOINTS_PER_DEVICE);
    assert!(!cps.contains(&history::checkpoint_name(A, now, "before-mass-delete")), "the oldest went first");
    assert!(cps.contains(&history::checkpoint_name(A, now + (MAX_CHECKPOINTS_PER_DEVICE as u64 + 2) * 1000, "before-mass-delete")));
}

#[test]
fn a_checkpoint_copies_the_live_snapshot() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    let ctx = ctx_at(&a, &p, day(0));
    assert_eq!(block_on(history::checkpoint(&ctx, "x")).unwrap(), None, "no snapshot yet");
    a.put("n.nqv", "text");
    sync_at(&mut a, &p, day(0));
    let ctx = ctx_at(&a, &p, day(0) + 5000);
    let name = block_on(history::checkpoint(&ctx, "Before sync guard")).unwrap().unwrap();
    assert!(name.ends_with("-before-sync-guard.nqs"), "{name}");
    assert_eq!(p.raw(&name), p.raw(&seal::device_object(A)));
    let pts = points(&a, &p);
    assert_eq!(pts.iter().map(|r| r.kind).collect::<Vec<_>>(), vec!["checkpoint", "daily"], "newest first");
}

/// Fails every history call (list/get/put/delete under `history/`).
struct NoHistory<'a>(&'a InMemoryProvider);

#[async_trait]
impl StorageProvider for NoHistory<'_> {
    fn id(&self) -> &'static str {
        "nohistory"
    }
    fn capabilities(&self) -> Capabilities {
        self.0.capabilities()
    }
    async fn list(&self, prefix: &str) -> Result<Vec<RemoteObject>, ProviderError> {
        if prefix.starts_with("history/") {
            return Err(ProviderError::Other("boom".into()));
        }
        self.0.list(prefix).await
    }
    async fn get(&self, name: &str) -> Result<Vec<u8>, ProviderError> {
        self.0.get(name).await
    }
    async fn put(&self, name: &str, data: &[u8]) -> Result<RemoteObject, ProviderError> {
        if name.starts_with("history/") {
            return Err(ProviderError::Offline);
        }
        self.0.put(name, data).await
    }
    async fn delete(&self, name: &str) -> Result<(), ProviderError> {
        self.0.delete(name).await
    }
}

#[test]
fn history_problems_never_fail_the_cycle() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("n.nqv", "text");
    let o = sync_at(&mut a, &NoHistory(&p), day(0));
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    assert!(!a.st.pending && p.raw(&seal::device_object(A)).is_some());
    assert!(history_of(&p, A).is_empty());
}

#[test]
fn restore_brings_back_items_deleted_later_even_after_another_device_pushed_the_deletion() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("keep.nqv", "stays");
    a.put("gone.nqv", "deleted later");
    a.put("edited.nqv", "old text");
    let att = a.v.db.lock().unwrap().attach_add("gone.nqv", "f.txt", &b64_encode(b"ATTACHED")).unwrap().id;
    a.st.pending = true;
    sync_at(&mut a, &p, day(0));
    let mut b = join(&p, B, "Desk", PW).unwrap();

    // Next day: the other device deletes it for good; the deletion reaches this one.
    wipe(&mut b, "gone.nqv");
    sync_at(&mut b, &p, day(1));
    sync_at(&mut a, &p, day(1));
    assert_eq!(a.text("gone.nqv"), None);
    a.put("edited.nqv", "new text");
    a.put("new.nqv", "made after the restore point");
    sync_at(&mut a, &p, day(1));

    // The UI: restore points grouped by date with device names (never ids).
    let pts = points(&a, &p);
    let first_day = pts.iter().find(|r| r.this_device && r.date == pts.last().unwrap().date).unwrap().clone();
    assert_eq!(first_day.device_name, "Laptop");
    assert!(pts.iter().any(|r| r.device_name == "Desk" && !r.this_device));
    assert!(pts.iter().all(|r| !r.device_name.contains(A) && !r.device_name.contains(B)));

    let backups = a.v.backups.lock().unwrap().len();
    let s = restore(&a, &p, &first_day.id).unwrap();
    assert_eq!((s.added, s.updated, s.attachments_missing), (1, 0, 0), "{s:?}");
    assert_eq!(s.date, first_day.date);
    let bk = a.v.backups.lock().unwrap();
    assert_eq!(bk.len(), backups + 1, "a safety backup first");
    assert!(bk.last().unwrap().to_string_lossy().contains(RESTORE_BACKUP_REASON));
    drop(bk);
    assert!(s.backup_path.is_some());

    // Nothing local was removed or overwritten; the old text of the edited note is in its history.
    assert_eq!(a.text("gone.nqv").as_deref(), Some("deleted later"));
    assert_eq!(a.text("keep.nqv").as_deref(), Some("stays"));
    assert_eq!(a.text("new.nqv").as_deref(), Some("made after the restore point"));
    assert_eq!(a.text("edited.nqv").as_deref(), Some("new text"));
    assert!(!a.v.db.lock().unwrap().history_list("edited.nqv").unwrap().is_empty());
    let data = a.v.db.lock().unwrap().attach_get("gone.nqv", &att).unwrap().data.clone();
    assert_eq!(data, b64_encode(b"ATTACHED"), "attachment data comes back from the store");

    // The normal cycle uploads it and the deletion doesn't win again anywhere.
    a.st.pending = true;
    sync_at(&mut a, &p, day(1) + 1000);
    sync_at(&mut b, &p, day(1) + 2000);
    sync_at(&mut a, &p, day(1) + 3000);
    assert_eq!(a.text("gone.nqv").as_deref(), Some("deleted later"));
    assert_eq!(b.text("gone.nqv").as_deref(), Some("deleted later"));
    assert_eq!(b.text("new.nqv").as_deref(), Some("made after the restore point"));
}

#[test]
fn restoring_another_devices_copy_works_and_missing_attachments_are_counted() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("seed.nqv", "x");
    sync_at(&mut a, &p, day(0));
    let mut b = join(&p, B, "Desk", PW).unwrap();
    b.put("b.nqv", "from desk");
    let att = b.v.db.lock().unwrap().attach_add("b.nqv", "f.bin", &b64_encode(b"LOST")).unwrap().id;
    b.st.pending = true;
    sync_at(&mut b, &p, day(1));
    sync_at(&mut a, &p, day(1));
    wipe(&mut a, "b.nqv");
    sync_at(&mut a, &p, day(2));
    // The blob is gone from the store (e.g. cleaned up): the note still comes back, without it.
    block_on(p.delete(&SyncKeys::derive(&b.v.key, &b.v.vault_id).blob_name(&att))).unwrap();
    let pt = points(&a, &p).into_iter().find(|r| r.device_name == "Desk").unwrap();
    let s = restore(&a, &p, &pt.id).unwrap();
    assert_eq!((s.added, s.attachments_missing), (1, 1), "{s:?}");
    assert_eq!(a.text("b.nqv").as_deref(), Some("from desk"));
    assert!(a.v.db.lock().unwrap().attach_list("b.nqv").unwrap().is_empty());
}

#[test]
fn foreign_tampered_or_swapped_copies_are_rejected_and_nothing_changes() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("n.nqv", "mine");
    sync_at(&mut a, &p, day(0));
    let mut b = join(&p, B, "Desk", PW).unwrap();
    b.put("b.nqv", "desk");
    sync_at(&mut b, &p, day(0));

    // Another vault's snapshot (same device id, different vault) placed under our history.
    let other_store = InMemoryProvider::new();
    let mut c = Device::create(A, "Intruder");
    c.put("evil.nqv", "x");
    sync_at(&mut c, &other_store, day(0));
    let foreign = other_store.raw(&seal::device_object(A)).unwrap();
    let foreign_name = history::daily_name(A, history::day_of(day(5)));
    block_on(p.put(&foreign_name, &foreign)).unwrap();

    // B's copy renamed as A's (wrong subject), and a tampered copy.
    let swapped = history::daily_name(A, history::day_of(day(6)));
    block_on(p.put(&swapped, &p.raw(&history::daily_name(B, history::day_of(day(0)))).unwrap())).unwrap();
    let mut bad = p.raw(&history::daily_name(A, history::day_of(day(0)))).unwrap();
    let i = bad.len() - 3;
    bad[i] ^= 1;
    let tampered = history::daily_name(A, history::day_of(day(7)));
    block_on(p.put(&tampered, &bad)).unwrap();

    let before = a.paths();
    let backups = a.v.backups.lock().unwrap().len();
    for id in [foreign_name.as_str(), swapped.as_str(), tampered.as_str()] {
        let e = restore(&a, &p, id).unwrap_err();
        assert!(matches!(&e, SyncError::Local(m) if m.contains("couldn't be verified")), "{id}: {e:?}");
    }
    for id in ["devices/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.nqs", "vault.meta", "history/../vault.meta"] {
        assert!(matches!(restore(&a, &p, id), Err(SyncError::Local(m)) if m.contains("isn't valid")), "{id}");
    }
    let missing = history::daily_name(A, history::day_of(day(9)));
    assert!(matches!(restore(&a, &p, &missing), Err(SyncError::Local(m)) if m.contains("no longer exists")));
    assert_eq!(a.paths(), before, "nothing changed");
    assert_eq!(a.text("n.nqv").as_deref(), Some("mine"));
    assert_eq!(a.v.backups.lock().unwrap().len(), backups, "no backup for a failed restore");
    assert_eq!(a.text("evil.nqv"), None);
}

#[test]
fn unknown_device_names_are_learned_from_their_copies_never_shown_as_ids() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("n.nqv", "x");
    sync_at(&mut a, &p, day(0));
    let mut b = join(&p, B, "Desk", PW).unwrap();
    b.put("b.nqv", "y");
    sync_at(&mut b, &p, day(0));
    // The device was removed (live snapshot gone) and this PC never learned its name.
    block_on(p.delete(&seal::device_object(B))).unwrap();
    let keys = SyncKeys::derive(&a.v.key, &a.v.vault_id);
    let mut known = BTreeMap::new();
    let (rows, learned) = block_on(history::list_points(&p, Some(&keys), &mut known, A, "Laptop")).unwrap();
    assert!(learned && known[B].name == "Desk");
    let names: HashMap<bool, String> = rows.iter().map(|r| (r.this_device, r.device_name.clone())).collect();
    assert_eq!((names[&true].as_str(), names[&false].as_str()), ("Laptop", "Desk"));
    // Locked (no keys): unknown names stay empty, never an id.
    let (rows, _) = block_on(history::list_points(&p, None, &mut BTreeMap::new(), A, "Laptop")).unwrap();
    assert!(rows.iter().any(|r| !r.this_device && r.device_name.is_empty()));
}
