//! Imported items that expire (`Entry::expires_at`, final tombstones) across devices and Drive: they are destroyed
//! everywhere whatever the order of the syncs, nothing else is touched, an edit or an old copy can't bring them
//! back, and the outbound guard doesn't mistake them for a mass deletion.

use super::*;
use crate::vault_db::now_ms;
use crate::vault_merge::merge_into;

const DAY: u64 = 86_400_000;

fn sync_at(d: &mut Device, p: &dyn StorageProvider, now: u64) -> Outcome {
    let ctx = Ctx::new(p, &d.v.key, &d.v.vault_id, d.id, &d.name, now);
    ok(block_on(sync_once(&ctx, &d.v, &mut d.st, Mode::Full)))
}

/// Marks the note at `path` as an imported item that expires at `at`.
fn expire(d: &mut Device, path: &str, at: u64) {
    d.edit(|db| {
        let e = db.entries.values_mut().find(|e| e.path == path).expect("the note exists");
        e.expires_at = Some(at);
    });
}

/// The state of an entry on a device: `Some(text)` while live, `None` once gone or destroyed.
fn live_text(d: &Device, path: &str) -> Option<String> {
    d.live_notes().contains(&path.to_string()).then(|| d.text(path)).flatten()
}

/// A destroyed entry holds nothing: a final tombstone without content, history or attachments.
fn assert_destroyed(d: &Device, path: &str) {
    let db = d.v.db.lock().unwrap();
    let e = db.entries.values().find(|e| e.path == path).unwrap_or_else(|| panic!("no record of {path} on {}", d.name));
    assert!(e.deleted && e.tomb.as_ref().is_some_and(|t| t.fin), "{path} on {} is a final tombstone", d.name);
    assert!(e.content.is_empty() && e.history.is_empty() && e.attachments.is_empty(), "{path} on {} keeps nothing", d.name);
}

#[test]
fn an_expired_item_is_destroyed_on_every_device_and_nothing_else_is_touched() {
    let p = InMemoryProvider::new();
    let exp = now_ms() + DAY;
    let mut a = Device::create(A, "A");
    a.put("mine.nqv", "personal");
    a.put("shared.nqv", "from a friend");
    expire(&mut a, "shared.nqv", exp);
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    assert_eq!(live_text(&b, "shared.nqv").as_deref(), Some("from a friend"), "B received it, with its expiry");
    // B adds its own note after the import: it must never be touched.
    b.put("later.nqv", "b's own");
    ok(b.sync(&p));

    // The first device to sync after the time destroys it, the other follows.
    let o = sync_at(&mut a, &p, exp + 1);
    assert!(o.pending_deletions.is_none() && o.changed_local);
    assert_destroyed(&a, "shared.nqv");
    sync_at(&mut b, &p, exp + 2);
    assert_destroyed(&b, "shared.nqv");
    for d in [&a, &b] {
        assert_eq!(live_text(d, "mine.nqv").as_deref(), Some("personal"));
        assert_eq!(live_text(d, "later.nqv").as_deref(), Some("b's own"));
    }
    // And it stays that way.
    sync_at(&mut a, &p, exp + 3);
    sync_at(&mut b, &p, exp + 4);
    assert_destroyed(&a, "shared.nqv");
    assert_destroyed(&b, "shared.nqv");
}

#[test]
fn the_order_of_the_syncs_does_not_matter() {
    for order in [[0usize, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2], [2, 0, 1], [0, 2, 1]] {
        let p = InMemoryProvider::new();
        let exp = now_ms() + DAY;
        let mut a = Device::create(A, "A");
        a.put("shared.nqv", "from a friend");
        a.put("mine.nqv", "personal");
        expire(&mut a, "shared.nqv", exp);
        ok(a.sync(&p));
        let b = join(&p, B, "B", PW).unwrap();
        let c = join(&p, C, "C", PW).unwrap();
        let mut devs = vec![a, b, c];
        for round in 0..2u64 {
            for &i in &order {
                sync_at(&mut devs[i], &p, exp + 1 + round);
            }
        }
        for d in &devs {
            assert_destroyed(d, "shared.nqv");
            assert_eq!(live_text(d, "mine.nqv").as_deref(), Some("personal"), "{} (order {order:?})", d.name);
        }
    }
}

#[test]
fn an_edit_made_before_the_time_on_a_device_that_was_offline_does_not_bring_it_back() {
    let p = InMemoryProvider::new();
    let exp = now_ms() + DAY;
    let mut a = Device::create(A, "A");
    a.put("shared.nqv", "from a friend");
    expire(&mut a, "shared.nqv", exp);
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    b.put("shared.nqv", "b added a line"); // newer than anything A has seen, never synced
    sync_at(&mut a, &p, exp + 1); // A destroys it and uploads that
    sync_at(&mut b, &p, exp + 2); // B comes back online
    assert_destroyed(&b, "shared.nqv");
    sync_at(&mut a, &p, exp + 3);
    assert_destroyed(&a, "shared.nqv");
}

#[test]
fn an_old_copy_never_brings_a_destroyed_item_back() {
    let p = InMemoryProvider::new();
    let exp = now_ms() + DAY;
    let mut a = Device::create(A, "A");
    a.put("shared.nqv", "from a friend");
    a.put("mine.nqv", "personal");
    expire(&mut a, "shared.nqv", exp);
    ok(a.sync(&p));
    let old = a.v.db.lock().unwrap().clone(); // what a backup, a history copy or a stale device holds
    sync_at(&mut a, &p, exp + 1);
    assert_destroyed(&a, "shared.nqv");

    // A sync merge with the old copy.
    a.edit(|db| { merge_into(db, &old); db.sweep_expired(exp + 2); });
    assert_destroyed(&a, "shared.nqv");
    // A restore from a backup (the "Merge" restore and "Restore vault from a date" use this).
    a.edit(|db| { db.merge_backup(&old); db.sweep_expired(exp + 2); });
    assert_destroyed(&a, "shared.nqv");
    assert_eq!(live_text(&a, "mine.nqv").as_deref(), Some("personal"));

    // Even a device that never knew it was destroyed, merging the old copy first and sweeping later, ends the same.
    let mut fresh = Device::create(C, "C");
    fresh.edit(|db| { merge_into(db, &old); });
    assert_eq!(live_text(&fresh, "shared.nqv").as_deref(), Some("from a friend"), "not yet swept");
    fresh.edit(|db| { db.sweep_expired(exp + 5); });
    assert_destroyed(&fresh, "shared.nqv");
}

#[test]
fn reconnecting_drive_first_does_not_bring_an_expired_item_back() {
    let p = InMemoryProvider::new();
    let exp = now_ms() + DAY;
    let mut a = Device::create(A, "A");
    a.put("shared.nqv", "from a friend");
    a.put("mine.nqv", "personal");
    expire(&mut a, "shared.nqv", exp);
    ok(a.sync(&p)); // Drive now holds the item as live
    a.disconnect();
    a.edit(|db| { db.sweep_expired(exp + 1); }); // the vault was opened after the time
    assert_destroyed(&a, "shared.nqv");
    a.enable(&p);
    let o = a.restore_from_drive(&p);
    assert_eq!(o.result.join.as_ref().map(|j| j.restored), Some(0), "nothing expired is 'restored'");
    assert_destroyed(&a, "shared.nqv");
    assert_eq!(live_text(&a, "mine.nqv").as_deref(), Some("personal"));
    // Drive carries the destruction on, for the other devices.
    let mut b = join(&p, B, "B", PW).unwrap();
    sync_at(&mut b, &p, exp + 2);
    assert_destroyed(&b, "shared.nqv");
}

#[test]
fn items_expiring_together_do_not_trip_the_outbound_guard_but_a_real_mass_delete_does() {
    // Every note in the vault is an imported one and they all expire: the upload must go through.
    let p = InMemoryProvider::new();
    let exp = now_ms() + DAY;
    let mut a = Device::create(A, "A");
    for n in ["one", "two", "three"] {
        a.put(&format!("{n}.nqv"), n);
        expire(&mut a, &format!("{n}.nqv"), exp);
    }
    ok(a.sync(&p));
    let o = sync_at(&mut a, &p, exp + 1);
    assert!(o.pending_deletions.is_none(), "expired items are not a deletion the user has to confirm");
    let mut b = join(&p, B, "B", PW).unwrap();
    sync_at(&mut b, &p, exp + 2);
    for n in ["one", "two", "three"] {
        assert_destroyed(&a, &format!("{n}.nqv"));
        assert_destroyed(&b, &format!("{n}.nqv"));
    }

    // The same vault, but the notes are deleted by hand: the guard still asks.
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    for n in ["one", "two", "three"] { a.put(&format!("{n}.nqv"), n); }
    ok(a.sync(&p));
    a.edit(|db| for n in ["one", "two", "three"] { let rel = format!("{n}.nqv"); db.trash(&rel).unwrap(); db.purge(&rel).unwrap(); });
    let o = a.sync(&p).unwrap();
    assert!(o.pending_deletions.is_some(), "a person deleting everything is still stopped");
}

#[test]
fn an_item_that_has_not_expired_yet_is_left_alone_everywhere() {
    let p = InMemoryProvider::new();
    let exp = now_ms() + 3 * DAY;
    let mut a = Device::create(A, "A");
    a.put("shared.nqv", "from a friend");
    expire(&mut a, "shared.nqv", exp);
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    sync_at(&mut a, &p, exp - 1);
    sync_at(&mut b, &p, exp - 1);
    assert_eq!(live_text(&a, "shared.nqv").as_deref(), Some("from a friend"));
    assert_eq!(live_text(&b, "shared.nqv").as_deref(), Some("from a friend"));
}
