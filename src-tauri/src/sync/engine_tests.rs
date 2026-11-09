//! Engine tests against `InMemoryProvider` (no network): devices are simulated with in-memory
//! local vaults and their own `SyncState`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use super::contract_tests::block_on;
use super::engine::*;
use super::memory::InMemoryProvider;
use super::provider::{ProviderError, StorageProvider};
use super::seal::{self, SyncKeys, META_NAME};
use super::state::{self, SyncState};
use crate::vault_core::{self as vc, KdfParams, VaultError, VaultKey, VaultMeta, VAULT_ID_LEN};
use crate::vault_db::{b64_encode, Db};
use crate::vault_hlc::Hlc;

mod history_tests; // Drive version history (sync::history)

const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };
const PW: &str = "correct horse battery";
const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const C: &str = "cccccccccccccccccccccccccccccccc";
const D: &str = "dddddddddddddddddddddddddddddddd";

static NEXT: AtomicU64 = AtomicU64::new(0);

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("nq-engine-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

struct TestVault {
    db: Mutex<Db>,
    meta: Mutex<VaultMeta>,
    prev: Mutex<Option<VaultMeta>>,
    key: VaultKey,
    vault_id: [u8; VAULT_ID_LEN],
    dir: PathBuf,
    seq: AtomicU64,
    backups: Mutex<Vec<PathBuf>>,
}

impl LocalVault for TestVault {
    fn read_db<T>(&self, f: impl FnOnce(&Db) -> T) -> Result<T, String> {
        Ok(f(&self.db.lock().unwrap()))
    }
    fn update_db<T>(&self, f: impl FnOnce(&mut Db) -> (T, bool)) -> Result<T, String> {
        Ok(f(&mut self.db.lock().unwrap()).0)
    }
    fn meta(&self) -> Result<VaultMeta, String> {
        Ok(self.meta.lock().unwrap().clone())
    }
    fn adopt_meta(&self, meta: &VaultMeta) -> Result<(), String> {
        let mut cur = self.meta.lock().unwrap();
        *self.prev.lock().unwrap() = Some(cur.clone());
        *cur = meta.clone();
        Ok(())
    }
    fn safety_backup(&self, reason: &str) -> Result<Option<PathBuf>, String> {
        let m = self.meta.lock().unwrap().to_json().into_bytes();
        let db = self.db.lock().unwrap().seal(&self.key, &self.vault_id)?;
        let n = NEXT.fetch_add(1, Ordering::SeqCst);
        let p = state::write_safety_backup(&self.dir, &m, &db, reason, n)?;
        self.backups.lock().unwrap().push(p.clone());
        Ok(Some(p))
    }
    fn change_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }
}

struct Device {
    id: &'static str,
    name: String,
    v: TestVault,
    st: SyncState,
}

impl Device {
    fn with(id: &'static str, name: &str, meta: VaultMeta, key: VaultKey, db: Db, meta_gen: u64) -> Device {
        let vault_id = meta.vault_id_bytes().unwrap();
        let mut db = db;
        db.device = id.into();
        let mut st = SyncState { enabled: true, ..Default::default() };
        st.reset_for_vault(&seal::vault_id_hex(&vault_id), meta_gen);
        Device {
            id,
            name: name.into(),
            v: TestVault { db: Mutex::new(db), meta: Mutex::new(meta), prev: Mutex::new(None), key, vault_id, dir: tmp(), seq: AtomicU64::new(0), backups: Mutex::new(vec![]) },
            st,
        }
    }

    /// The first device: creates the vault.
    fn create(id: &'static str, name: &str) -> Device {
        let (meta, key, _) = vc::create_vault(PW, FAST).unwrap();
        Device::with(id, name, meta, key, Db::new(), 1)
    }

    fn edit(&mut self, f: impl FnOnce(&mut Db)) {
        f(&mut self.v.db.lock().unwrap());
        self.v.seq.fetch_add(1, Ordering::SeqCst);
        self.st.pending = true;
    }

    fn put(&mut self, path: &str, text: &str) {
        self.edit(|db| db.put(path, "md", text).unwrap());
    }

    fn sync(&mut self, p: &dyn StorageProvider) -> Result<Outcome, SyncError> {
        self.sync_mode(p, Mode::Full)
    }

    fn sync_mode(&mut self, p: &dyn StorageProvider, mode: Mode) -> Result<Outcome, SyncError> {
        let key = self.v.key.clone();
        let ctx = Ctx::new(p, &key, &self.v.vault_id, self.id, &self.name, crate::vault_db::now_ms());
        block_on(sync_once(&ctx, &self.v, &mut self.st, mode))
    }

    fn text(&self, path: &str) -> Option<String> {
        self.v.db.lock().unwrap().get(path).map(|e| e.content.clone())
    }

    fn paths(&self) -> Vec<String> {
        self.v.db.lock().unwrap().list().into_iter().map(|i| i.rel).collect()
    }

    fn set_clock(&mut self, wall: u64) {
        let mut db = self.v.db.lock().unwrap();
        db.clock = Hlc { wall, counter: 0, device: self.id.into() };
    }
}

/// New-device flow (what `sync_join` does): remote meta → password → verify → empty vault → sync.
fn join(p: &dyn StorageProvider, id: &'static str, name: &str, password: &str) -> Result<Device, SyncError> {
    let rm = block_on(fetch_meta(p))?.ok_or(SyncError::NoRemoteVault)?;
    let key = vc::unlock_with_password(&rm.meta, password).map_err(|_| SyncError::WrongPassword)?;
    let prep = block_on(prepare_switch(p, &rm, &key, id, name, crate::vault_db::now_ms(), None))?;
    let mut d = Device::with(id, name, rm.meta.clone(), key, prep.db, rm.generation);
    d.st = prep.state;
    d.sync(p)?;
    Ok(d)
}

fn ok(o: Result<Outcome, SyncError>) -> Outcome {
    let o = o.unwrap();
    assert!(o.upload_error.is_none(), "{:?}", o.upload_error);
    o
}

fn far() -> u64 {
    crate::vault_db::now_ms() + 10_000_000
}

#[test]
fn first_enable_uploads_meta_and_snapshot() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("note.nqv", "hello");
    let o = ok(a.sync(&p));
    assert!(p.raw(META_NAME).is_some());
    assert!(p.raw(&seal::device_object(A)).is_some());
    assert_eq!((a.st.own_generation, a.st.pending, a.st.first_sync_done), (1, false, true));
    assert!(o.backup.is_some_and(|b| b.exists()), "safety copy before the first sync");
    // The store never sees plaintext.
    for name in [META_NAME.to_string(), seal::device_object(A)] {
        let raw = p.raw(&name).unwrap();
        assert!(!raw.windows(5).any(|w| w == b"hello"), "{name}");
    }
    // Nothing changed → nothing uploaded.
    p.reset_calls();
    ok(a.sync(&p));
    assert_eq!(p.calls().put, 0);
}

#[test]
fn second_device_joins_with_the_password() {
    let p = InMemoryProvider::new();
    assert!(matches!(join(&p, B, "Desk", PW), Err(SyncError::NoRemoteVault)));
    let mut a = Device::create(A, "Laptop");
    a.put("note.nqv", "from A");
    ok(a.sync(&p));
    let e = join(&p, B, "Desk", "not the password").err().unwrap();
    assert_eq!(e, SyncError::WrongPassword);
    assert_eq!(e.message(), "WRONG_PASSWORD");
    let b = join(&p, B, "Desk", PW).unwrap();
    assert_eq!(b.text("note.nqv").as_deref(), Some("from A"));
    assert!(p.raw(&seal::device_object(B)).is_some());
    assert_eq!(b.st.devices[A].name, "Laptop");
}

#[test]
fn two_and_three_devices_converge() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("shared.nqv", "v0");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    let mut c = join(&p, C, "C", PW).unwrap();
    a.put("a.nqv", "only a");
    b.put("b.nqv", "only b");
    c.put("c.nqv", "only c");
    b.edit(|db| db.rename("shared.nqv", "renamed.nqv").unwrap());
    c.put("shared.nqv", "edited by c");
    for _ in 0..2 {
        for d in [&mut a, &mut b, &mut c] {
            ok(d.sync(&p));
        }
    }
    let ea = a.v.db.lock().unwrap().entries.clone();
    assert_eq!(ea, b.v.db.lock().unwrap().entries.clone());
    assert_eq!(ea, c.v.db.lock().unwrap().entries.clone());
    for d in [&a, &b, &c] {
        assert_eq!(d.text("renamed.nqv").as_deref(), Some("edited by c"), "rename + edit both survive");
        assert_eq!(d.paths(), vec!["a.nqv", "b.nqv", "c.nqv", "renamed.nqv"]);
        assert!(!d.st.pending);
    }
}

#[test]
fn a_conflict_is_reported_once_with_the_device_name() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop A");
    a.put("n.nqv", "base");
    ok(a.sync(&p));
    let mut b = join(&p, B, "Desk B", PW).unwrap();
    let t = far();
    a.set_clock(t);
    b.set_clock(t + 1000);
    a.put("n.nqv", "from A");
    b.put("n.nqv", "from B");
    ok(a.sync(&p));
    // B pulls A's older edit: B's version wins, A's is kept as a conflict revision.
    let o = ok(b.sync(&p));
    assert_eq!(o.result.conflicts, vec![SyncConflict { path: "n.nqv".into(), from_device: "Laptop A".into() }]);
    assert!(ok(b.sync(&p)).result.conflicts.is_empty(), "reported once");
    ok(a.sync(&p));
    assert_eq!(a.text("n.nqv").as_deref(), Some("from B"));
    let hist = a.v.db.lock().unwrap().history_list("n.nqv").unwrap().len();
    assert!(hist >= 1, "the losing version is in the history");
    assert!(ok(a.sync(&p)).result.conflicts.is_empty());
}

#[test]
fn offline_changes_queue_and_go_out_later() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    a.put("x.nqv", "written offline");
    p.set_offline(true);
    let e = a.sync(&p).err().unwrap();
    assert_eq!(e.message(), "SYNC_OFFLINE");
    assert!(a.st.pending);
    p.set_offline(false);
    ok(a.sync(&p));
    assert!(!a.st.pending);
    ok(b.sync(&p));
    assert_eq!(b.text("x.nqv").as_deref(), Some("written offline"));
}

#[test]
fn rate_limited_keeps_pending() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("x.nqv", "1");
    p.set_rate_limited(Some(7));
    let e = a.sync(&p).err().unwrap();
    assert_eq!(e, SyncError::Provider(ProviderError::RateLimited { retry_after_s: 7 }));
    assert!(e.message().contains("7 s"));
    assert!(a.st.pending);
    p.set_rate_limited(None);
    ok(a.sync(&p));
    assert!(!a.st.pending);
}

#[test]
fn an_aborted_upload_leaves_the_remote_consistent_and_nothing_is_lost() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("n.nqv", "v1");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    b.put("b.nqv", "from b");
    ok(b.sync(&p));
    a.put("n.nqv", "v2");
    p.abort_next_puts(1);
    let o = a.sync(&p).unwrap();
    assert_eq!(o.upload_error, Some(SyncError::Provider(ProviderError::Offline)));
    assert!(a.st.pending, "pending stays set");
    assert_eq!(a.text("b.nqv").as_deref(), Some("from b"), "the merge was kept locally");
    assert_eq!(a.st.own_generation, 1, "no generation was used up");
    // The store still holds A's previous, valid snapshot.
    let o = ok(b.sync(&p));
    assert!(o.warnings.is_empty(), "{:?}", o.warnings);
    assert_eq!(b.text("n.nqv").as_deref(), Some("v1"));
    ok(a.sync(&p));
    assert!(!a.st.pending);
    ok(b.sync(&p));
    assert_eq!(b.text("n.nqv").as_deref(), Some("v2"));
}

#[test]
fn a_stale_or_rolled_back_snapshot_is_rejected() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("n.nqv", "gen1");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    a.put("n.nqv", "gen2");
    ok(a.sync(&p));
    ok(b.sync(&p));
    assert_eq!(b.st.seen[A], 2);
    a.put("n.nqv", "gen3");
    ok(a.sync(&p));
    p.serve_stale(&seal::device_object(A), 2); // the server hands out gen1
    let o = ok(b.sync(&p));
    assert!(o.warnings.iter().any(|w| w.contains("older copy")), "{:?}", o.warnings);
    assert_eq!(b.text("n.nqv").as_deref(), Some("gen2"));
    p.serve_stale(&seal::device_object(A), 0);
    ok(b.sync(&p));
    assert_eq!(b.text("n.nqv").as_deref(), Some("gen3"));
}

#[test]
fn tampered_and_swapped_objects_are_rejected() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("secret.nqv", "a's note");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    let a_snap = p.raw(&seal::device_object(A)).unwrap();
    block_on(async {
        // A's snapshot under another device's name.
        p.put(&seal::device_object(D), &a_snap).await.unwrap();
        // A snapshot of another vault.
        let (m2, k2, _) = vc::create_vault(PW, FAST).unwrap();
        let other = SyncKeys::derive(&k2, &m2.vault_id_bytes().unwrap());
        let snap = seal::new_snapshot(C, "Evil", 1, 1, Db::new());
        p.put(&seal::device_object(C), &seal::seal_snapshot(&other, &snap).unwrap()).await.unwrap();
    });
    let o = ok(b.sync(&p));
    assert_eq!(o.warnings.iter().filter(|w| w.contains("couldn't be verified")).count(), 2, "{:?}", o.warnings);
    assert!(!b.st.seen.contains_key(C) && !b.st.seen.contains_key(D));
    // A flipped byte in A's own snapshot.
    let mut bad = a_snap.clone();
    let i = bad.len() - 3;
    bad[i] ^= 1;
    block_on(p.put(&seal::device_object(A), &bad)).unwrap();
    let o = ok(b.sync(&p));
    assert!(o.warnings.iter().any(|w| w.contains("couldn't be verified")));
    assert_eq!(b.text("secret.nqv").as_deref(), Some("a's note"));
}

#[test]
fn blobs_are_uploaded_once_and_fetched_on_the_other_device() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("n.nqv", "with file");
    let meta = {
        let mut db = a.v.db.lock().unwrap();
        db.attach_add("n.nqv", "pic.png", &b64_encode(b"PNGDATA-123")).unwrap()
    };
    a.st.pending = true;
    ok(a.sync(&p));
    let blob = SyncKeys::derive(&a.v.key, &a.v.vault_id).blob_name(&meta.id);
    assert_eq!(p.version_count(&blob), 1);
    let snap = p.raw(&seal::device_object(A)).unwrap();
    assert!(!snap.windows(7).any(|w| w == b"PNGDATA"), "attachment data is not in the snapshot");
    let mut b = join(&p, B, "B", PW).unwrap();
    let got = b.v.db.lock().unwrap().attach_get("n.nqv", &meta.id).unwrap().data.clone();
    assert_eq!(got, b64_encode(b"PNGDATA-123"));
    a.put("n.nqv", "edited");
    ok(a.sync(&p));
    b.put("other.nqv", "x");
    ok(b.sync(&p));
    ok(a.sync(&p));
    assert_eq!(p.version_count(&blob), 1, "uploaded once");
    assert_eq!(list_now(&p, seal::BLOBS_PREFIX).len(), 1);
}

fn list_now(p: &InMemoryProvider, prefix: &str) -> Vec<super::provider::RemoteObject> {
    block_on(StorageProvider::list(p, prefix)).unwrap()
}

#[test]
fn a_missing_blob_is_retried_without_blocking_the_rest() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("n.nqv", "text");
    let id = a.v.db.lock().unwrap().attach_add("n.nqv", "f.txt", &b64_encode(b"abc")).unwrap().id;
    a.st.pending = true;
    ok(a.sync(&p));
    let blob = SyncKeys::derive(&a.v.key, &a.v.vault_id).blob_name(&id);
    let saved = p.raw(&blob).unwrap();
    block_on(p.delete(&blob)).unwrap();
    let mut b = join(&p, B, "B", PW).unwrap();
    assert_eq!(b.text("n.nqv").as_deref(), Some("text"));
    assert!(b.v.db.lock().unwrap().attach_list("n.nqv").unwrap().is_empty());
    block_on(p.put(&blob, &saved)).unwrap();
    ok(b.sync(&p));
    assert_eq!(b.v.db.lock().unwrap().attach_list("n.nqv").unwrap().len(), 1, "retried on the next sync");
}

#[test]
fn path_collisions_are_renamed_and_converge() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    a.put("Bank.nqv", "a's bank");
    b.put("Bank.nqv", "b's bank");
    a.edit(|db| db.mkdir("Work").unwrap());
    b.edit(|db| db.mkdir("Work").unwrap());
    ok(a.sync(&p));
    ok(b.sync(&p));
    ok(a.sync(&p));
    ok(b.sync(&p));
    for d in [&a, &b] {
        assert_eq!(d.paths(), vec!["Bank (2).nqv", "Bank.nqv", "Work"]);
        let texts = [d.text("Bank.nqv").unwrap(), d.text("Bank (2).nqv").unwrap()];
        assert!(texts.contains(&"a's bank".to_string()) && texts.contains(&"b's bank".to_string()));
        assert!(crate::vault_merge::path_collisions(&d.v.db.lock().unwrap()).is_empty());
    }
    assert_eq!(a.v.db.lock().unwrap().entries, b.v.db.lock().unwrap().entries);
}

#[test]
fn a_large_remote_deletion_takes_a_safety_backup_first() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    for i in 0..12 {
        a.put(&format!("n{i:02}.nqv"), "x");
    }
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    let before = b.v.backups.lock().unwrap().len();
    a.put("n00.nqv", "small change");
    ok(a.sync(&p));
    assert!(ok(b.sync(&p)).backup.is_none(), "a small change needs no copy");
    a.edit(|db| for i in 1..12 { db.trash(&format!("n{i:02}.nqv")).unwrap(); });
    ok(a.sync(&p));
    let o = ok(b.sync(&p));
    let path = o.backup.expect("safety copy");
    assert!(path.exists() && path.to_string_lossy().contains("large-change"));
    assert_eq!(b.v.backups.lock().unwrap().len(), before + 1);
    assert_eq!(o.result.removed, 11);
    let raw = std::fs::read(path).unwrap();
    assert!(crate::vault_backup::parse_container(&raw).is_ok());
}

#[test]
fn a_password_change_on_one_device_is_adopted_by_the_other() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    let old = a.v.meta().unwrap();
    let newer = vc::rewrap_password(&old, &a.v.key, "brand new password").unwrap();
    *a.v.meta.lock().unwrap() = newer.clone();
    a.st.meta_generation += 1;
    a.st.meta_pending = true;
    ok(a.sync(&p));
    assert!(!a.st.meta_pending);
    let o = ok(b.sync(&p));
    assert!(o.meta_adopted);
    assert_eq!(b.v.meta().unwrap(), newer);
    assert_eq!(b.st.meta_generation, 2);
    let prev = b.v.prev.lock().unwrap().clone();
    assert_eq!(prev.as_ref(), Some(&old), "the previous meta is kept");
    let e = vc::unlock_with_password_or_previous(&newer, prev.as_ref(), PW).unwrap_err();
    assert_eq!(e, VaultError::PasswordChangedElsewhere);
    let k = vc::unlock_with_password_or_previous(&newer, prev.as_ref(), "brand new password").unwrap();
    assert_eq!(*k, *b.v.key, "same key everywhere");
    // A device that missed it joins with the new password only.
    assert!(matches!(join(&p, C, "C", PW), Err(SyncError::WrongPassword)));
    assert!(join(&p, C, "C", "brand new password").is_ok());
    // A rolled-back vault.meta (old generation) is not adopted, and is repaired.
    p.serve_stale(META_NAME, 1);
    b.st.forget_revisions();
    let o = ok(b.sync(&p));
    assert!(!o.meta_adopted && o.warnings.iter().any(|w| w.contains("older copy")));
    assert_eq!(b.v.meta().unwrap(), newer);
}

// ─── 0.9.0: two password changes at nearly the same time → the later change wins ─────────────

/// 10:00 on some day (Unix ms); the examples are minutes after it.
const T10: u64 = 1_793_000_000_000;
const MIN: u64 = 60_000;
const AAM: &str = "Aam12345";
const KELA: &str = "Kela4567";

impl Device {
    /// What `vault_change_password` does: re-wrap, stamp (this device, `at_ms`), forget the previous
    /// meta, and note the change for sync (also while paused for this vault).
    fn change_password(&mut self, password: &str, at_ms: u64) -> VaultMeta {
        let mut m = vc::rewrap_password(&self.v.meta().unwrap(), &self.v.key, password).unwrap();
        m.stamp_change(at_ms, Some(self.id));
        *self.v.meta.lock().unwrap() = m.clone();
        *self.v.prev.lock().unwrap() = None;
        let ours = self.st.vault_id.as_deref() == Some(seal::vault_id_hex(&self.v.vault_id).as_str());
        self.st.note_local_meta_change(ours);
        m
    }

    /// The unlock screen: the current meta plus the one a synced change replaced.
    fn unlock(&self, password: &str) -> Result<(), VaultError> {
        let prev = self.v.prev.lock().unwrap().clone();
        vc::unlock_with_password_or_previous(&self.v.meta().unwrap(), prev.as_ref(), password).map(|_| ())
    }
}

/// Laptop + Office, both synced on the original password.
fn laptop_and_office(p: &InMemoryProvider) -> (Device, Device) {
    let mut laptop = Device::create(A, "Laptop");
    ok(laptop.sync(p));
    let mut office = join(p, B, "Office", PW).unwrap();
    ok(office.sync(p));
    (laptop, office)
}

fn assert_later_change_everywhere(p: &InMemoryProvider, winner: &Device, loser: &Device, new_pw: &str, old_pw: &str, winner_meta: &VaultMeta) {
    assert_eq!(&winner.v.meta().unwrap(), winner_meta);
    assert_eq!(&loser.v.meta().unwrap(), winner_meta, "the later change is everywhere");
    let rm = block_on(fetch_meta(p)).unwrap().unwrap();
    assert_eq!(&rm.meta, winner_meta, "and in the store");
    assert!(!winner.st.meta_pending && !loser.st.meta_pending);
    assert_eq!(winner.unlock(new_pw), Ok(()));
    assert_eq!(loser.unlock(new_pw), Ok(()));
    assert_eq!(loser.unlock(old_pw), Err(VaultError::PasswordChangedElsewhere), "the losing PC's own password");
    assert_eq!(loser.unlock(PW), Err(VaultError::WrongPassword));
    assert!(matches!(join(p, C, "C", old_pw), Err(SyncError::WrongPassword)));
    assert!(join(p, C, "C", new_pw).is_ok());
}

#[test]
fn later_password_change_wins_when_the_earlier_one_synced_first() {
    // Laptop sets "Aam…" at 10:00 and syncs; the offline Office sets "Kela…" at 10:02.
    let p = InMemoryProvider::new();
    let (mut laptop, mut office) = laptop_and_office(&p);
    laptop.change_password(AAM, T10);
    ok(laptop.sync(&p));
    let kela = office.change_password(KELA, T10 + 2 * MIN);
    let o = ok(office.sync(&p));
    assert!(!o.meta_adopted, "Office's later change is kept");
    assert!(o.warnings.iter().any(|w| w.contains("later change, made on this device")), "{:?}", o.warnings);
    let o = ok(laptop.sync(&p));
    assert!(o.meta_adopted);
    assert_later_change_everywhere(&p, &office, &laptop, KELA, AAM, &kela);
    // Nothing moves on further cycles.
    assert!(!ok(office.sync(&p)).meta_adopted && !ok(laptop.sync(&p)).meta_adopted);
    assert_eq!(laptop.unlock(AAM), Err(VaultError::PasswordChangedElsewhere));
}

#[test]
fn later_password_change_wins_when_it_synced_first() {
    // Same changes; this time the offline Office comes back first, then the Laptop.
    let p = InMemoryProvider::new();
    let (mut laptop, mut office) = laptop_and_office(&p);
    laptop.change_password(AAM, T10);
    let kela = office.change_password(KELA, T10 + 2 * MIN);
    let o = ok(office.sync(&p));
    assert!(!o.meta_adopted && o.warnings.is_empty(), "nothing concurrent in the store yet: {:?}", o.warnings);
    let stored = p.raw(META_NAME).unwrap();
    let o = ok(laptop.sync(&p));
    assert!(o.meta_adopted);
    assert!(o.warnings.iter().any(|w| w.contains("later than here")), "{:?}", o.warnings);
    assert_eq!(p.raw(META_NAME).unwrap(), stored, "the losing Laptop's pending change never overwrites the winner");
    ok(office.sync(&p));
    assert_later_change_everywhere(&p, &office, &laptop, KELA, AAM, &kela);
}

#[test]
fn the_later_change_wins_whoever_uploads_last() {
    // Reversed clocks: the Laptop's change is the later one; both sync orders.
    for laptop_first in [true, false] {
        let p = InMemoryProvider::new();
        let (mut laptop, mut office) = laptop_and_office(&p);
        let aam = laptop.change_password(AAM, T10 + 2 * MIN);
        office.change_password(KELA, T10);
        if laptop_first {
            ok(laptop.sync(&p));
            assert!(ok(office.sync(&p)).meta_adopted);
        } else {
            ok(office.sync(&p));
            assert!(!ok(laptop.sync(&p)).meta_adopted);
            assert!(ok(office.sync(&p)).meta_adopted);
        }
        ok(laptop.sync(&p));
        assert_later_change_everywhere(&p, &laptop, &office, AAM, KELA, &aam);
    }
}

#[test]
fn several_offline_changes_still_lose_to_a_later_one_and_rollback_is_still_rejected() {
    let p = InMemoryProvider::new();
    let (mut laptop, mut office) = laptop_and_office(&p);
    // Office changes twice while offline (its generation is now two above the store)...
    office.change_password("first offline pw", T10);
    office.change_password(KELA, T10 + MIN);
    // ...the Laptop changes once, later, and syncs first.
    let aam = laptop.change_password(AAM, T10 + 5 * MIN);
    ok(laptop.sync(&p));
    let o = ok(office.sync(&p));
    assert!(o.meta_adopted, "a higher local generation doesn't beat a later change");
    assert_later_change_everywhere(&p, &laptop, &office, AAM, KELA, &aam);
    // A rolled-back store (an older vault.meta) is still never adopted.
    // (The first repair adds a version, so the second device is served two versions back.)
    for (back, d) in [(1, &mut office), (2, &mut laptop)] {
        p.serve_stale(META_NAME, back);
        d.st.forget_revisions();
        let o = ok(d.sync(&p));
        assert!(!o.meta_adopted && o.warnings.iter().any(|w| w.contains("older copy")), "{:?}", o.warnings);
        assert_eq!(d.v.meta().unwrap(), aam);
    }
    p.serve_stale(META_NAME, 0);
    assert_eq!(block_on(fetch_meta(&p)).unwrap().unwrap().meta, aam, "and it was repaired");
}

#[test]
fn a_rolled_back_store_never_beats_a_pending_change_even_with_a_later_stamp() {
    // Laptop: change one (10:05), change two (10:06), both synced to the Office. The store is then
    // rolled back to change one: below what the Office agreed on, so it is replaced, never treated
    // as a concurrent change.
    let p = InMemoryProvider::new();
    let (mut laptop, mut office) = laptop_and_office(&p);
    laptop.change_password("laptop change one", T10 + 5 * MIN);
    ok(laptop.sync(&p));
    ok(office.sync(&p));
    let two = laptop.change_password(AAM, T10 + 6 * MIN);
    ok(laptop.sync(&p));
    ok(office.sync(&p));
    assert_eq!(office.v.meta().unwrap(), two);
    p.serve_stale(META_NAME, 1); // change one again
    office.st.forget_revisions();
    let o = ok(office.sync(&p));
    assert!(!o.meta_adopted);
    assert_eq!(office.v.meta().unwrap(), two);
}

#[test]
fn a_sequential_change_wins_even_with_an_earlier_clock() {
    // Office adopted the Laptop's change, then changes again with a clock that runs behind: that is
    // not a race (it was made after seeing the Laptop's), so it wins, and its stamp moves forward.
    let p = InMemoryProvider::new();
    let (mut laptop, mut office) = laptop_and_office(&p);
    laptop.change_password(AAM, T10 + 10 * MIN);
    ok(laptop.sync(&p));
    assert!(ok(office.sync(&p)).meta_adopted);
    let kela = office.change_password(KELA, T10); // clock 10 minutes behind
    assert!(kela.changed_at_ms.unwrap() > T10 + 10 * MIN);
    ok(office.sync(&p));
    assert!(ok(laptop.sync(&p)).meta_adopted);
    assert_later_change_everywhere(&p, &office, &laptop, KELA, AAM, &kela);
}

#[test]
fn a_password_change_made_while_paused_competes_by_time_on_resume() {
    for paused_is_later in [true, false] {
        let p = InMemoryProvider::new();
        let (mut laptop, mut office) = laptop_and_office(&p);
        office.st.enabled = false; // "Pause"
        let (office_at, laptop_at) = if paused_is_later { (T10 + 2 * MIN, T10) } else { (T10, T10 + 2 * MIN) };
        let kela = office.change_password(KELA, office_at);
        assert!(office.st.meta_pending, "a change made while paused for this vault waits for upload");
        let aam = laptop.change_password(AAM, laptop_at);
        ok(laptop.sync(&p));
        // "Resume sync" (what sync_enable does).
        let rm = block_on(fetch_meta(&p)).unwrap().unwrap();
        prepare_enable(&mut office.st, &seal::vault_id_hex(&office.v.vault_id), Some(&rm)).unwrap();
        ok(office.sync(&p));
        ok(laptop.sync(&p));
        if paused_is_later {
            assert_later_change_everywhere(&p, &office, &laptop, KELA, AAM, &kela);
        } else {
            assert_later_change_everywhere(&p, &laptop, &office, AAM, KELA, &aam);
        }
    }
}

#[test]
fn a_change_for_another_vault_while_paused_is_not_queued() {
    let mut st = SyncState { vault_id: Some("aa".into()), meta_generation: 4, ..Default::default() };
    assert!(!st.note_local_meta_change(false));
    assert!(!st.meta_pending && st.meta_generation == 4);
    assert!(st.note_local_meta_change(true));
    assert_eq!((st.meta_pending, st.meta_generation, st.meta_base()), (true, 5, 4));
    assert!(st.note_local_meta_change(true));
    assert_eq!((st.meta_generation, st.meta_base()), (6, 4), "the base stays where the store was");
    // State written before 0.9.0's rule (no base recorded) falls back to one below.
    let legacy = SyncState { meta_generation: 3, meta_pending: true, ..Default::default() };
    assert_eq!(legacy.meta_base(), 2);
    // An old vault-sync.json without the new field still loads.
    let old: SyncState = serde_json::from_str(r#"{"enabled":true,"metaGeneration":2,"metaPending":true}"#).unwrap();
    assert_eq!((old.meta_synced_generation, old.meta_base()), (None, 1));
}

#[test]
fn metas_without_a_change_stamp_keep_the_old_rule() {
    // Both sides unstamped (pre-0.9.0 metas): a tie goes to the store, a higher generation wins.
    let p = InMemoryProvider::new();
    let (mut laptop, mut office) = laptop_and_office(&p);
    let old = laptop.v.meta().unwrap();
    let a = vc::rewrap_password(&old, &laptop.v.key, AAM).unwrap();
    *laptop.v.meta.lock().unwrap() = a.clone();
    laptop.st.note_local_meta_change(true);
    ok(laptop.sync(&p));
    let b = vc::rewrap_password(&old, &office.v.key, KELA).unwrap();
    *office.v.meta.lock().unwrap() = b;
    office.st.note_local_meta_change(true);
    assert!(ok(office.sync(&p)).meta_adopted, "tie → the store's copy");
    assert_eq!(office.v.meta().unwrap(), a);
    assert_eq!(office.unlock(AAM), Ok(()));
    // A stamped change against an unstamped store copy at the same base: the change is uploaded.
    let c = office.change_password(KELA, T10);
    ok(office.sync(&p));
    assert!(ok(laptop.sync(&p)).meta_adopted);
    assert_eq!(laptop.v.meta().unwrap(), c);
}

/// Machine 2 with its own vault (`sync_adopt_remote`), import and backup-only.
fn machine2() -> (Db, VaultMeta, VaultKey) {
    let (meta, key, _) = vc::create_vault("local pc password", FAST).unwrap();
    let mut db = Db::new();
    db.device = B.into();
    db.put("same.nqv", "md", "identical").unwrap();
    db.put("diff.nqv", "md", "this pc version").unwrap();
    db.put("Work/new.nqv", "md", "only here").unwrap();
    db.mkdir("Work").unwrap();
    db.attach_add("Work/new.nqv", "a.txt", &b64_encode(b"local attachment")).unwrap();
    db.put("gone.nqv", "md", "trashed").unwrap();
    db.trash("gone.nqv").unwrap();
    (db, meta, key)
}

fn remote_with_a(p: &InMemoryProvider) -> Device {
    let mut a = Device::create(A, "A");
    a.put("same.nqv", "identical");
    a.put("diff.nqv", "remote version");
    a.edit(|db| db.mkdir("Work").unwrap());
    ok(a.sync(p));
    a
}

fn adopt(p: &InMemoryProvider, local: &Db, local_meta: &VaultMeta, local_key: &VaultKey, import: bool) -> (Device, ImportCounts, PathBuf) {
    let dir = tmp();
    let backup = state::write_local_vault_backup(&dir, local_meta.to_json().as_bytes(), &local.seal(local_key, &local_meta.vault_id_bytes().unwrap()).unwrap(), 1).unwrap();
    let rm = block_on(fetch_meta(p)).unwrap().unwrap();
    let key = vc::unlock_with_password(&rm.meta, PW).unwrap();
    let prep = block_on(prepare_switch(p, &rm, &key, B, "PC", 1, import.then_some(local))).unwrap();
    let counts = prep.counts.clone();
    let mut d = Device::with(B, "PC", rm.meta.clone(), key, prep.db, rm.generation);
    d.st = prep.state;
    ok(d.sync(p));
    (d, counts, backup)
}

#[test]
fn adopt_remote_imports_this_pcs_entries() {
    let p = InMemoryProvider::new();
    let mut a = remote_with_a(&p);
    let (local, lm, lk) = machine2();
    let (b, counts, backup) = adopt(&p, &local, &lm, &lk, true);
    assert_eq!(counts, ImportCounts { imported: 2, skipped: 2, renamed: 1, attachments_skipped: 0 });
    assert!(crate::vault_backup::parse_container(&std::fs::read(&backup).unwrap()).is_ok());
    ok(a.sync(&p));
    for d in [&a, &b] {
        assert_eq!(d.paths(), vec!["diff (This PC).nqv", "diff.nqv", "same.nqv", "Work", "Work/new.nqv"]);
        assert_eq!(d.text("diff.nqv").as_deref(), Some("remote version"));
        assert_eq!(d.text("diff (This PC).nqv").as_deref(), Some("this pc version"));
        assert_eq!(d.v.db.lock().unwrap().attach_list("Work/new.nqv").unwrap().len(), 1);
    }
    assert_eq!(b.v.meta().unwrap().vault_id, a.v.meta().unwrap().vault_id, "this device now uses the remote vault");
}

#[test]
fn adopt_remote_backup_only_keeps_the_local_vault_in_the_file() {
    let p = InMemoryProvider::new();
    let mut a = remote_with_a(&p);
    let (local, lm, lk) = machine2();
    let (b, counts, backup) = adopt(&p, &local, &lm, &lk, false);
    assert_eq!(counts, ImportCounts::default());
    ok(a.sync(&p));
    assert_eq!(a.paths(), vec!["diff.nqv", "same.nqv", "Work"]);
    assert_eq!(b.paths(), a.paths());
    let raw = std::fs::read(&backup).unwrap();
    let parsed = crate::vault_backup::parse_container(&raw).unwrap();
    let _ = parsed; // the old vault (its vault.json + vault.nqdb) is restorable from the file
}

#[test]
fn import_respects_attachment_limits() {
    let mut target = Db::new();
    target.device = A.into();
    let mut local = Db::new();
    local.device = B.into();
    local.put("n.nqv", "md", "x").unwrap();
    for i in 0..20 {
        local.attach_add("n.nqv", &format!("{i}.bin"), &b64_encode(&vec![1u8; 1000])).unwrap();
    }
    // Fill the target close to its 25 MB limit.
    target.put("big.nqv", "md", "y").unwrap();
    for i in 0..5 {
        target.attach_add("big.nqv", &format!("{i}.bin"), &b64_encode(&vec![0u8; 5 * 1024 * 1024 - 2_000])).unwrap();
    }
    let c = import_local(&mut target, &local);
    assert_eq!(c.imported, 1);
    assert!(c.attachments_skipped > 0 && c.attachments_skipped < 20, "{c:?}");
    assert!(target.attachments_total() <= crate::vault_db::MAX_ATTACH_TOTAL);
}

#[test]
fn a_merge_may_exceed_attachment_limits_but_new_ones_are_refused() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("n.nqv", "x");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    for (d, tag) in [(&mut a, "a"), (&mut b, "b")] {
        d.edit(|db| for i in 0..12 { db.attach_add("n.nqv", &format!("{tag}{i}.txt"), &b64_encode(b"1")).unwrap(); });
    }
    ok(a.sync(&p));
    ok(b.sync(&p));
    ok(a.sync(&p));
    for d in [&a, &b] {
        let mut db = d.v.db.lock().unwrap();
        assert_eq!(db.attach_list("n.nqv").unwrap().len(), 24, "nothing dropped");
        assert!(db.attach_add("n.nqv", "more.txt", &b64_encode(b"1")).is_err(), "new ones refused over the limit");
    }
}

#[test]
fn removed_devices_disappear_and_a_reset_device_continues_above_its_old_generation() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("a.nqv", "1");
    ok(a.sync(&p));
    let mut c = join(&p, C, "C", PW).unwrap();
    c.put("c.nqv", "from c");
    ok(c.sync(&p));
    ok(c.sync(&p));
    ok(a.sync(&p));
    assert!(a.st.devices.contains_key(C));
    block_on(p.delete(&seal::device_object(C))).unwrap(); // sync_remove_device
    ok(a.sync(&p));
    assert!(!a.st.devices.contains_key(C));
    // A loses its sync state (e.g. vault-sync.json deleted): it adopts its remote generation.
    let gen = a.st.own_generation;
    a.st.own_generation = 0;
    a.st.seen.clear();
    a.st.forget_revisions();
    a.put("a2.nqv", "2");
    ok(a.sync(&p));
    assert_eq!(a.st.own_generation, gen + 1);
}

#[test]
fn push_only_uploads_without_fetching() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    b.put("b.nqv", "b");
    ok(b.sync(&p));
    a.put("a.nqv", "final push");
    ok(a.sync_mode(&p, Mode::PushOnly));
    assert!(!a.st.pending);
    assert!(a.text("b.nqv").is_none(), "push-only doesn't merge");
    ok(b.sync(&p));
    assert_eq!(b.text("a.nqv").as_deref(), Some("final push"));
}

#[test]
fn a_different_remote_vault_is_reported() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    ok(a.sync(&p));
    let mut other = Device::create(B, "B");
    let e = other.sync(&p).err().unwrap();
    assert_eq!(e.message(), "REMOTE_VAULT_DIFFERENT");
    assert!(p.raw(&seal::device_object(B)).is_none(), "nothing uploaded");
}

#[test]
fn syncing_never_deletes_the_remote_vault() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    a.put("n.nqv", "x");
    ok(a.sync(&p));
    a.edit(|db| { db.trash("n.nqv").unwrap(); db.empty_trash(); });
    ok(a.sync(&p));
    // Turning sync off / disconnecting only changes local state; the store keeps everything.
    a.st.enabled = false;
    assert!(p.raw(META_NAME).is_some() && p.raw(&seal::device_object(A)).is_some());
    assert_eq!(p.calls().delete, 0);
}

#[test]
fn re_enabling_adopts_a_password_change_made_elsewhere_and_never_reverts_it() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "A");
    ok(a.sync(&p));
    let mut b = join(&p, B, "B", PW).unwrap();
    b.st.enabled = false; // B turns sync off
    // A changes the password while B is off.
    let old = a.v.meta().unwrap();
    let newer = vc::rewrap_password(&old, &a.v.key, "brand new password").unwrap();
    *a.v.meta.lock().unwrap() = newer.clone();
    a.st.meta_generation += 1;
    a.st.meta_pending = true;
    ok(a.sync(&p));
    let remote_before = p.raw(META_NAME).unwrap();
    // B turns sync on again (what sync_enable does).
    let rm = block_on(fetch_meta(&p)).unwrap().unwrap();
    let hex = seal::vault_id_hex(&b.v.vault_id);
    prepare_enable(&mut b.st, &hex, Some(&rm)).unwrap();
    let o = ok(b.sync(&p));
    assert!(o.meta_adopted);
    assert_eq!(b.v.meta().unwrap(), newer);
    assert_eq!(p.raw(META_NAME).unwrap(), remote_before, "the synced vault.meta is unchanged");
    let prev = b.v.prev.lock().unwrap().clone();
    assert_eq!(vc::unlock_with_password_or_previous(&newer, prev.as_ref(), PW).unwrap_err(), VaultError::PasswordChangedElsewhere);
    // A tie (same generation, different wrap, e.g. concurrent changes): the synced copy wins.
    let mine = vc::rewrap_password(&newer, &b.v.key, "b's own password").unwrap();
    *b.v.meta.lock().unwrap() = mine;
    b.st.meta_pending = true;
    b.st.forget_revisions();
    let o = ok(b.sync(&p));
    assert!(o.meta_adopted);
    assert_eq!(b.v.meta().unwrap(), newer);
    assert_eq!(p.raw(META_NAME).unwrap(), remote_before, "a tie never overwrites the synced copy");
    // A genuine change made while connected (generation above the synced one) is uploaded.
    let mine = vc::rewrap_password(&newer, &b.v.key, "b's own password").unwrap();
    *b.v.meta.lock().unwrap() = mine.clone();
    b.st.meta_generation += 1;
    b.st.meta_pending = true;
    ok(b.sync(&p));
    ok(a.sync(&p));
    assert_eq!(a.v.meta().unwrap(), mine);
    // Re-enabling against a different remote vault is refused.
    let (m2, _, _) = vc::create_vault(PW, FAST).unwrap();
    assert_eq!(prepare_enable(&mut b.st, &m2.vault_id, Some(&rm)), Err(SyncError::RemoteVaultDifferent));
}

#[test]
fn join_and_adopt_change_nothing_when_the_download_fails() {
    let p = InMemoryProvider::new();
    let mut a = remote_with_a(&p);
    a.edit(|db| { db.attach_add("same.nqv", "f.txt", &b64_encode(b"blob")).unwrap(); });
    ok(a.sync(&p));
    let rm = block_on(fetch_meta(&p)).unwrap().unwrap();
    let key = vc::unlock_with_password(&rm.meta, PW).unwrap();
    let (local, _, _) = machine2();
    let before = local.entries.clone();
    for fault in [ProviderError::Offline, ProviderError::Auth, ProviderError::RateLimited { retry_after_s: 3 }] {
        match &fault {
            ProviderError::Offline => p.set_offline(true),
            ProviderError::Auth => p.set_auth_expired(true),
            _ => p.set_rate_limited(Some(3)),
        }
        for import in [None, Some(&local)] {
            let r = block_on(prepare_switch(&p, &rm, &key, B, "PC", 1, import));
            assert_eq!(r.err().map(|e| e.message()), Some(SyncError::Provider(fault.clone()).message()));
        }
        p.clear_faults();
    }
    // The listing works, then every snapshot download fails (connection lost mid-download).
    let mid = FailGets { inner: &p, err: ProviderError::Offline };
    for import in [None, Some(&local)] {
        assert_eq!(block_on(prepare_switch(&mid, &rm, &key, B, "PC", 1, import)).err(), Some(SyncError::Provider(ProviderError::Offline)));
    }
    assert_eq!(local.entries, before, "this PC's vault is untouched");
    // A missing blob doesn't block a join: it is fetched on a later sync.
    let blob = {
        let db = a.v.db.lock().unwrap();
        let id = db.get("same.nqv").unwrap().attachments[0].id.clone();
        SyncKeys::derive(&a.v.key, &a.v.vault_id).blob_name(&id)
    };
    p.clear_faults();
    let saved = p.raw(&blob).unwrap();
    block_on(p.delete(&blob)).unwrap();
    let prep = block_on(prepare_switch(&p, &rm, &key, B, "PC", 1, None)).unwrap();
    assert!(prep.warnings.iter().any(|w| w.contains("attachments")));
    assert_eq!(prep.db.get("same.nqv").unwrap().content, "identical");
    block_on(p.put(&blob, &saved)).unwrap();
    // Tampered meta is refused before anything is downloaded.
    let (m2, k2, _) = vc::create_vault(PW, FAST).unwrap();
    let _ = m2;
    assert!(block_on(prepare_switch(&p, &rm, &k2, B, "PC", 1, None)).is_err());
}

/// Lists normally but fails every download (a connection lost after the listing).
struct FailGets<'a> {
    inner: &'a InMemoryProvider,
    err: ProviderError,
}

#[async_trait::async_trait]
impl StorageProvider for FailGets<'_> {
    fn id(&self) -> &'static str {
        "fail-gets"
    }
    fn capabilities(&self) -> super::provider::Capabilities {
        self.inner.capabilities()
    }
    async fn list(&self, prefix: &str) -> Result<Vec<super::provider::RemoteObject>, ProviderError> {
        self.inner.list(prefix).await
    }
    async fn get(&self, _name: &str) -> Result<Vec<u8>, ProviderError> {
        Err(self.err.clone())
    }
    async fn put(&self, name: &str, data: &[u8]) -> Result<super::provider::RemoteObject, ProviderError> {
        self.inner.put(name, data).await
    }
    async fn delete(&self, name: &str) -> Result<(), ProviderError> {
        self.inner.delete(name).await
    }
}

// ─── devices list: names, never ids ─────────────────────────────────────────

#[test]
fn devices_list_never_shows_ids_and_learns_names_from_snapshots() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("n.nqv", "x");
    ok(a.sync(&p));
    let b = join(&p, B, "Desk", PW).unwrap();

    // A fresh install (C) that hasn't synced: no names known and no key → empty names, not ids.
    let mut known = std::collections::BTreeMap::new();
    let (rows, learned) = block_on(list_devices(&p, None, &mut known, C, "CODEMUNI")).unwrap();
    assert!(!learned);
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.name.is_empty() && !r.this_device), "{rows:?}");
    assert!(rows.iter().all(|r| r.last_seen_ms.is_some()));

    // Same, but unlocked: names are read from the snapshots and remembered.
    let keys = SyncKeys::derive(&b.v.key, &b.v.vault_id);
    let (rows, learned) = block_on(list_devices(&p, Some(&keys), &mut known, C, "CODEMUNI")).unwrap();
    assert!(learned);
    let names: Vec<_> = rows.iter().map(|r| r.name.as_str()).collect();
    assert!(names.contains(&"Laptop") && names.contains(&"Desk"), "{names:?}");
    assert_eq!(known[A].name, "Laptop");

    // On B: B is "this device", first, with its current name; nothing to learn.
    let mut known_b = b.st.devices.clone();
    p.reset_calls();
    let (rows, learned) = block_on(list_devices(&p, Some(&keys), &mut known_b, B, "Desk renamed")).unwrap();
    assert!(!learned);
    assert_eq!(p.calls().get, 0, "known names need no download");
    assert!(rows[0].this_device && rows[0].id == B && rows[0].name == "Desk renamed");
    assert_eq!(rows.iter().filter(|r| r.this_device).count(), 1);
    assert_eq!(rows[1].name, "Laptop");
}

#[test]
fn devices_list_with_an_unreadable_snapshot_has_an_empty_name() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    ok(a.sync(&p));
    // Another vault's key can't open A's snapshot.
    let other = Device::create(B, "Other");
    let keys = SyncKeys::derive(&other.v.key, &other.v.vault_id);
    let mut known = std::collections::BTreeMap::new();
    let (rows, learned) = block_on(list_devices(&p, Some(&keys), &mut known, B, "Other")).unwrap();
    assert!(!learned);
    assert_eq!((rows.len(), rows[0].name.as_str(), rows[0].this_device), (1, "", false));
}

#[test]
fn a_renamed_device_uploads_its_new_name_and_others_pick_it_up() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop");
    a.put("n.nqv", "x");
    ok(a.sync(&p));
    let mut b = join(&p, B, "Desk", PW).unwrap();
    assert_eq!(b.st.devices[A].name, "Laptop");
    // What sync_set_device_name does: new name + pending.
    a.name = "CODEMUNI".into();
    a.st.pending = true;
    ok(a.sync(&p));
    assert!(!a.st.pending);
    ok(b.sync(&p));
    assert_eq!(b.st.devices[A].name, "CODEMUNI");
}

#[test]
fn conflict_notices_name_the_device_even_after_its_name_was_forgotten() {
    let p = InMemoryProvider::new();
    let mut a = Device::create(A, "Laptop A");
    a.put("n.nqv", "v0");
    ok(a.sync(&p));
    let mut b = join(&p, B, "Desk", PW).unwrap();
    let t = far();
    a.set_clock(t);
    b.set_clock(t + 1000);
    a.put("n.nqv", "from A");
    b.put("n.nqv", "from B");
    ok(a.sync(&p));
    // B lost what it knew about A (state reset): the name comes from the snapshot just opened, never the id.
    b.st.devices.clear();
    let o = ok(b.sync(&p));
    assert_eq!(o.result.conflicts, vec![SyncConflict { path: "n.nqv".into(), from_device: "Laptop A".into() }]);
}

// ─── 0.9.1: a KDF auto-upgrade syncs, but never beats a real password change ─────────────────

impl Device {
    /// What `vault_unlock` does after unlocking a vault with weaker Argon2 settings: same password,
    /// stronger KDF, stamped with the lowest stamp after the meta it replaces.
    fn upgrade_kdf(&mut self) -> VaultMeta {
        let target = KdfParams { m_kib: FAST.m_kib * 2, t: FAST.t + 1, p: 1 };
        let mut m = vc::upgrade_kdf(&self.v.meta().unwrap(), &self.v.key, PW, &target).unwrap();
        m.stamp_change(0, Some(self.id));
        *self.v.meta.lock().unwrap() = m.clone();
        *self.v.prev.lock().unwrap() = None;
        let ours = self.st.vault_id.as_deref() == Some(seal::vault_id_hex(&self.v.vault_id).as_str());
        self.st.note_local_meta_change(ours);
        m
    }
}

#[test]
fn kdf_upgrade_reaches_the_other_device_and_the_password_still_works() {
    let p = InMemoryProvider::new();
    let (mut laptop, mut office) = laptop_and_office(&p);
    let up = office.upgrade_kdf();
    ok(office.sync(&p));
    assert!(ok(laptop.sync(&p)).meta_adopted);
    assert_eq!(laptop.v.meta().unwrap(), up);
    assert_eq!((laptop.unlock(PW), office.unlock(PW)), (Ok(()), Ok(())));
}

#[test]
fn a_concurrent_password_change_beats_a_kdf_upgrade_in_both_orders() {
    for upgrade_first in [true, false] {
        let p = InMemoryProvider::new();
        let (mut laptop, mut office) = laptop_and_office(&p);
        // The Laptop changes the password at 10:00; the offline Office, still on the old password,
        // upgrades its KDF later (its clock is later, but the upgrade's stamp is not).
        let aam = laptop.change_password(AAM, T10);
        office.upgrade_kdf();
        if upgrade_first {
            ok(office.sync(&p));
            assert!(!ok(laptop.sync(&p)).meta_adopted, "the password change is kept");
            assert!(ok(office.sync(&p)).meta_adopted);
        } else {
            ok(laptop.sync(&p));
            assert!(ok(office.sync(&p)).meta_adopted);
        }
        ok(laptop.sync(&p));
        assert_eq!(office.v.meta().unwrap(), aam);
        assert_eq!(laptop.v.meta().unwrap(), aam);
        assert_eq!(office.unlock(AAM), Ok(()));
    }
}

// ─── restoring a backup of a synced vault ────────────────────────────────────

/// The app's `LocalVault`: the real `VaultState` over a `vault.nqdb` on disk (load, the restore
/// re-stamp, atomic save), as `sync::commands::TauriLocal` uses it.
struct DiskVault {
    vs: crate::vault::VaultState,
    meta: VaultMeta,
    key: VaultKey,
    vault_id: [u8; VAULT_ID_LEN],
    st: SyncState,
}

impl LocalVault for DiskVault {
    fn read_db<T>(&self, f: impl FnOnce(&Db) -> T) -> Result<T, String> {
        self.vs.with_db_quiet(|db, _, _, _| Ok((f(db), false)))
    }
    fn update_db<T>(&self, f: impl FnOnce(&mut Db) -> (T, bool)) -> Result<T, String> {
        self.vs.with_db_quiet(|db, _, _, _| Ok(f(db)))
    }
    fn meta(&self) -> Result<VaultMeta, String> {
        Ok(self.meta.clone())
    }
    fn adopt_meta(&self, _: &VaultMeta) -> Result<(), String> {
        Ok(())
    }
    fn safety_backup(&self, _: &str) -> Result<Option<PathBuf>, String> {
        Ok(None)
    }
    fn change_seq(&self) -> u64 {
        self.vs.change_seq()
    }
}

impl DiskVault {
    /// A PC with no vault restores `backup` (a `.nqbackup` container) and unlocks it.
    /// `st` is its sync state for that vault (connected, sync on).
    fn restore(backup: &[u8], meta: &VaultMeta, key: &VaultKey, st: SyncState) -> DiskVault {
        let dir = tmp();
        crate::vault_backup::install(&dir, &dir.join("vault.json"), &dir.join("vault.nqdb"), backup, false, 1).unwrap();
        let vs = crate::vault::VaultState::default();
        vs.ensure_device(&dir);
        vs.set_root(dir);
        let vault_id = meta.vault_id_bytes().unwrap();
        vs.install_key(key.clone(), vault_id);
        DiskVault { vs, meta: meta.clone(), key: key.clone(), vault_id, st }
    }

    fn sync(&mut self, p: &dyn StorageProvider) -> Outcome {
        let dev = self.vs.device_id().unwrap();
        let ctx = Ctx::new(p, &self.key, &self.vault_id, &dev, "This PC", crate::vault_db::now_ms());
        let mut st = self.st.clone();
        let o = ok(block_on(sync_once(&ctx, &*self, &mut st, Mode::Full)));
        self.st = st;
        o
    }

    fn live(&self) -> Vec<String> {
        self.read_db(|db| db.list().into_iter().filter(|i| !i.dir).map(|i| i.rel).collect()).unwrap()
    }
}

/// The exporting PC's vault with three notes (one with an attachment), and its `.nqbackup`.
fn exported_vault() -> (Device, Vec<u8>) {
    let mut a = Device::create(A, "Laptop");
    a.put("a.nqv", "one");
    a.put("Folder/b.nqv", "two");
    a.put("c.nqv", "three");
    a.edit(|db| { db.attach_add("c.nqv", "f.txt", &b64_encode(b"file")).unwrap(); });
    let db = a.v.db.lock().unwrap().seal(&a.v.key, &a.v.vault_id).unwrap();
    let backup = crate::vault_backup::build_container(a.v.meta.lock().unwrap().to_json().as_bytes(), &db);
    (a, backup)
}

fn sync_on(meta: &VaultMeta) -> SyncState {
    let mut st = SyncState { provider: Some("gdrive".into()), ..Default::default() };
    prepare_enable(&mut st, &meta.vault_id, None).unwrap();
    st
}

#[test]
fn an_empty_store_never_wipes_a_restored_vault() {
    // Restore the export on a PC with no vault, Drive connected and empty, then turn sync on.
    let (a, backup) = exported_vault();
    let meta = a.v.meta.lock().unwrap().clone();
    let p = InMemoryProvider::new();
    let mut pc = DiskVault::restore(&backup, &meta, &a.v.key, sync_on(&meta));
    assert_eq!(pc.live().len(), 3);
    for _ in 0..3 {
        pc.sync(&p);
        assert_eq!(pc.live().len(), 3);
    }
    let b = join(&p, B, "Other", PW).unwrap();
    assert_eq!(b.paths().iter().filter(|p| p.ends_with(".nqv")).count(), 3, "uploaded to the store");
    assert_eq!(b.v.db.lock().unwrap().get("c.nqv").unwrap().attachments.len(), 1);
}

#[test]
fn a_restored_backup_survives_deletions_the_synced_copy_made_after_it() {
    // Exported, then everything was deleted (and synced): the store's copy of the vault is empty.
    let (mut a, backup) = exported_vault();
    let meta = a.v.meta.lock().unwrap().clone();
    let p = InMemoryProvider::new();
    ok(a.sync(&p));
    a.edit(|db| {
        for path in ["a.nqv", "Folder", "c.nqv"] { db.trash(path).unwrap(); }
        db.empty_trash();
    });
    ok(a.sync(&p));
    assert!(a.paths().is_empty());

    // Control: the restored file as it is (no restore marker) — the store's deletions remove it again.
    let mut stale = DiskVault::restore(&backup, &meta, &a.v.key, sync_on(&meta));
    let marker = crate::vault_db::restored_marker_path(&stale.vs.root().unwrap());
    std::fs::remove_file(&marker).unwrap();
    assert_eq!(stale.live().len(), 3);
    stale.sync(&p);
    assert!(stale.live().is_empty(), "the bug: an old copy loses to the store's later deletions");

    // The restore: its entries are a new change, kept here and brought back everywhere.
    let mut pc = DiskVault::restore(&backup, &meta, &a.v.key, sync_on(&meta));
    let marker = crate::vault_db::restored_marker_path(&pc.vs.root().unwrap());
    assert_eq!(pc.live().len(), 3);
    assert!(!marker.exists(), "re-stamped once, on the first load");
    assert!(pc.change_seq() > 0, "counted as a local change, so it is uploaded");
    pc.sync(&p);
    pc.sync(&p);
    assert_eq!(pc.live(), vec!["a.nqv", "c.nqv", "Folder/b.nqv"]);
    ok(a.sync(&p));
    assert_eq!(a.text("Folder/b.nqv").as_deref(), Some("two"));
    let db = a.v.db.lock().unwrap();
    let att = &db.get("c.nqv").unwrap().attachments;
    assert!(att.len() == 1 && !att[0].data.is_empty(), "the attachment comes back too");
}

// ─── merging a backup into a synced vault ────────────────────────────────────

impl DiskVault {
    /// A PC that already has this vault (holding `db`) on disk and unlocked.
    fn open(db: &Db, meta: &VaultMeta, key: &VaultKey, st: SyncState) -> DiskVault {
        let dir = tmp();
        let vault_id = meta.vault_id_bytes().unwrap();
        std::fs::write(dir.join("vault.json"), meta.to_json()).unwrap();
        std::fs::write(crate::vault_db::db_path(&dir), db.seal(key, &vault_id).unwrap()).unwrap();
        let vs = crate::vault::VaultState::default();
        vs.ensure_device(&dir);
        vs.set_root(dir);
        vs.install_key(key.clone(), vault_id);
        DiskVault { vs, meta: meta.clone(), key: key.clone(), vault_id, st }
    }
}

#[test]
fn a_merged_backup_survives_deletions_the_synced_copy_made_after_it() {
    // Exported, then everything was deleted (and synced): the store holds only tombstones for it.
    let (mut a, backup) = exported_vault();
    let meta = a.v.meta.lock().unwrap().clone();
    let p = InMemoryProvider::new();
    ok(a.sync(&p));
    a.edit(|db| {
        for path in ["a.nqv", "Folder", "c.nqv"] { db.trash(path).unwrap(); }
        db.empty_trash();
    });
    ok(a.sync(&p));

    // A second PC on the same vault, with a note of its own, has synced those deletions.
    let mut own = Db::new();
    own.device = C.into();
    own.put("pc.nqv", "md", "mine").unwrap();
    let mut pc = DiskVault::open(&own, &meta, &a.v.key, sync_on(&meta));
    pc.sync(&p);
    assert_eq!(pc.live(), vec!["pc.nqv"]);

    // Merge the old backup into it: every entry it adds is a new local change.
    let root = pc.vs.root().unwrap();
    let key = crate::vault_backup::backup_key(&backup, PW).unwrap();
    let seq = pc.change_seq();
    let r = crate::vault_backup::merge_into_vault(&pc.vs, &root, &root.join("vault.json"), &backup, &key, 1).unwrap();
    assert!(pc.change_seq() > seq, "counted as a local change, so it is uploaded");
    assert!(format!("{r:?}").contains("added: 3"), "{r:?}");
    pc.st.pending = true; // what the change hook does in the app (sync::commands::on_local_change)
    for _ in 0..2 {
        pc.sync(&p);
        assert_eq!(pc.live(), vec!["a.nqv", "c.nqv", "Folder/b.nqv", "pc.nqv"], "the older deletions don't remove it");
    }

    // And it comes back on the device that deleted it.
    ok(a.sync(&p));
    assert_eq!(a.text("Folder/b.nqv").as_deref(), Some("two"));
    assert_eq!(a.text("pc.nqv").as_deref(), Some("mine"));
    let db = a.v.db.lock().unwrap();
    let att = &db.get("c.nqv").unwrap().attachments;
    assert!(att.len() == 1 && !att[0].data.is_empty(), "the attachment comes back too");
}
