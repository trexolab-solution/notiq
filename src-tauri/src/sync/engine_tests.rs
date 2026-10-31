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
