//! Cleaning the copies of this vault that sit on this PC, once an imported item has been destroyed (see
//! `Db::sweep_expired`). The live database no longer holds the item, but older copies of the database do: the
//! rotating `vault.nqdb.bak.1..3`, the sync safety copies, the copies kept before a backup merge or restore, and the
//! one made when the format was upgraded. The "changed by sync" markers can hold a replaced version of it too.
//!
//! Nothing is thrown away wholesale. Each copy is opened with the vault key, the destroyed items are removed from
//! it (the same final tombstone the live vault has), and it is written back in place, so the recovery points keep
//! everything else (the receiver's own notes included). A copy this vault's key doesn't open (another vault) is
//! left alone. Copies in Google Drive are not touched here.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::vault_core::{VaultKey, VAULT_ID_LEN};
use crate::vault_db::{self as vdb, Db};

/// What a cleaning pass did.
#[derive(Serialize, Debug, Default, PartialEq, Eq)]
pub struct ScrubReport {
    /// Copies of the vault that were opened.
    pub checked: u32,
    /// Copies that held a destroyed item and were written again without it.
    pub rewritten: u32,
    /// Markers of destroyed items that were dropped.
    pub markers_dropped: u32,
}

/// Removes from `copy` what `main` has destroyed (every entry that is a final tombstone there) and whatever has
/// expired by `now`. Returns how many entries were destroyed in the copy.
pub fn scrub_db(copy: &mut Db, main: &Db, now: u64) -> usize {
    let ids = main.final_ids();
    copy.destroy_ids(&ids, now) + copy.sweep_expired(now).len()
}

/// A sealed database (`vault.nqdb`-style bytes) without the destroyed items. `None` when nothing needed removing, or
/// when this vault's key doesn't open it (then it is not ours to touch).
pub fn scrub_sealed(bytes: &[u8], key: &VaultKey, id: &[u8; VAULT_ID_LEN], main: &Db, now: u64) -> Option<Vec<u8>> {
    let mut db = Db::open(key, id, bytes).ok()??;
    if scrub_db(&mut db, main, now) == 0 {
        return None;
    }
    db.seal(key, id).ok()
}

/// A backup container (`.nqbackup` / `.nqb`) without the destroyed items; the same rules as [`scrub_sealed`].
pub fn scrub_container(bytes: &[u8], key: &VaultKey, id: &[u8; VAULT_ID_LEN], main: &Db, now: u64) -> Option<Vec<u8>> {
    let p = crate::vault_backup::parse_container(bytes).ok()?;
    if p.meta.vault_id_bytes().ok()? != *id {
        return None;
    }
    let sealed = scrub_sealed(p.db_bytes, key, id, main, now)?;
    let out = crate::vault_backup::build_container_of(p.kind, p.meta_bytes, &sealed);
    crate::vault_backup::parse_container(&out).ok()?; // never write a copy we couldn't read back
    Some(out)
}

fn is_container(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("nqbackup") || e.eq_ignore_ascii_case("nqb"))
}

/// The files that may hold a copy of the vault: other `vault.nqdb.*` files beside the live one, the safety copies,
/// and the database inside each folder kept before a backup merge or restore. `(path, is_container)`.
fn candidates(root: &Path, app_data: &Path) -> Vec<(PathBuf, bool)> {
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(root) {
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(name) = name.to_str() else { continue };
            // `vault.nqdb` itself is the live database; the markers and the restore marker are not copies.
            if name != vdb::DB_FILE && crate::vault::is_vault_db_file(name) && e.path().is_file() {
                out.push((e.path(), false));
            }
        }
    }
    if let Ok(rd) = fs::read_dir(app_data.join(crate::sync::state::SAFETY_DIR)) {
        for e in rd.flatten() {
            if e.path().is_file() && is_container(&e.path()) {
                out.push((e.path(), true));
            }
        }
    }
    if let Ok(rd) = fs::read_dir(app_data) {
        for e in rd.flatten() {
            let name = e.file_name();
            let Some(name) = name.to_str() else { continue };
            if (name.starts_with("before-merge-") || name.starts_with("before-restore-")) && e.path().is_dir() {
                let db = e.path().join(vdb::DB_FILE);
                if db.is_file() {
                    out.push((db, false));
                }
            }
        }
    }
    out.sort();
    out
}

/// Drops the markers of destroyed items (a marker can hold the replaced version of a note).
fn scrub_markers(root: &Path, key: &VaultKey, id: &[u8; VAULT_ID_LEN], destroyed: &BTreeSet<String>) -> u32 {
    if destroyed.is_empty() {
        return 0;
    }
    let before = crate::sync::markers::load(root, key, id);
    let kept: Vec<_> = before.iter().filter(|m| !destroyed.contains(&m.id)).cloned().collect();
    let dropped = (before.len() - kept.len()) as u32;
    if dropped > 0 && crate::sync::markers::save(root, key, id, kept).is_err() {
        return 0;
    }
    dropped
}

/// One cleaning pass over every copy of the vault on this PC, for the destroyed items of `main` (the live database).
/// Failures of single files are skipped: the next pass tries again.
pub fn scrub_local_copies(root: &Path, app_data: &Path, key: &VaultKey, id: &[u8; VAULT_ID_LEN], main: &Db, now: u64) -> ScrubReport {
    let mut report = ScrubReport::default();
    let destroyed: BTreeSet<String> = main.final_ids().into_iter().collect();
    if destroyed.is_empty() && !main.entries.values().any(|e| e.expires_at.is_some()) {
        return report;
    }
    for (path, container) in candidates(root, app_data) {
        let Ok(bytes) = fs::read(&path) else { continue };
        let opens = if container {
            crate::vault_backup::parse_container(&bytes).is_ok_and(|p| p.meta.vault_id_bytes().is_ok_and(|v| v == *id))
        } else {
            Db::open(key, id, &bytes).is_ok_and(|d| d.is_some())
        };
        if !opens {
            continue;
        }
        report.checked += 1;
        let new = if container { scrub_container(&bytes, key, id, main, now) } else { scrub_sealed(&bytes, key, id, main, now) };
        if let Some(new) = new {
            if crate::vault::atomic_write(&path, &new).is_ok() {
                report.rewritten += 1;
            }
        }
    }
    report.markers_dropped = scrub_markers(root, key, id, &destroyed);
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_core::{create_vault, KdfParams};

    const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };
    const NOW: u64 = 1_800_000_000_000;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nq-scrub-{name}-{}-{}", std::process::id(), rand::random::<u32>()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A vault with a note of its own and an imported one that expires at `NOW`.
    struct Fixture {
        key: VaultKey,
        id: [u8; VAULT_ID_LEN],
        meta_json: Vec<u8>,
        before: Db, // the database while the imported item was alive
        main: Db,   // the live database after it was destroyed
    }

    fn fixture() -> Fixture {
        let (meta, key, _) = create_vault("a-long-test-password-1", FAST).unwrap();
        let id = meta.vault_id_bytes().unwrap();
        let mut db = Db::new();
        db.device = "dev".into();
        db.put("mine.nqv", "md", "my own note").unwrap();
        db.put("shared.nqv", "login", "the shared secret").unwrap();
        db.put("shared.nqv", "login", "the shared secret v2").unwrap();
        db.entries.values_mut().find(|e| e.path == "shared.nqv").unwrap().expires_at = Some(NOW);
        let before = db.clone();
        let mut main = db;
        assert_eq!(main.sweep_expired(NOW + 1).len(), 1);
        Fixture { key, id, meta_json: meta.to_json().into_bytes(), before, main }
    }

    fn has_secret(db: &Db) -> bool {
        db.entries.values().any(|e| e.content.contains("shared secret") || e.history.iter().any(|r| r.content.contains("shared secret")))
    }

    fn live(db: &Db, path: &str) -> Option<String> {
        db.entries.values().find(|e| e.path == path && !e.deleted).map(|e| e.content.clone())
    }

    #[test]
    fn a_copy_loses_the_destroyed_item_and_keeps_the_rest() {
        let f = fixture();
        let sealed = f.before.seal(&f.key, &f.id).unwrap();
        let new = scrub_sealed(&sealed, &f.key, &f.id, &f.main, NOW + 1).expect("it held the item");
        let back = Db::open(&f.key, &f.id, &new).unwrap().unwrap();
        assert!(!has_secret(&back));
        assert_eq!(live(&back, "mine.nqv").as_deref(), Some("my own note"), "the rest is still there");
        let gone = back.entries.values().find(|e| e.path == "shared.nqv").unwrap();
        assert!(gone.deleted && gone.tomb.as_ref().is_some_and(|t| t.fin) && gone.history.is_empty());
        // A second pass finds nothing to do.
        assert!(scrub_sealed(&new, &f.key, &f.id, &f.main, NOW + 1).is_none());
    }

    #[test]
    fn a_copy_that_never_held_the_item_is_left_alone_and_so_is_another_vaults() {
        let f = fixture();
        let mut other = Db::new();
        other.device = "dev".into();
        other.put("x.nqv", "md", "x").unwrap();
        let sealed = other.seal(&f.key, &f.id).unwrap();
        assert!(scrub_sealed(&sealed, &f.key, &f.id, &f.main, NOW + 1).is_none());
        let (meta2, key2, _) = create_vault("another-long-password-2", FAST).unwrap();
        let foreign = f.before.seal(&key2, &meta2.vault_id_bytes().unwrap()).unwrap();
        assert!(scrub_sealed(&foreign, &f.key, &f.id, &f.main, NOW + 1).is_none(), "not opened by this vault's key");
        assert!(scrub_sealed(b"junk", &f.key, &f.id, &f.main, NOW + 1).is_none());
    }

    #[test]
    fn a_destroyed_item_goes_from_a_copy_even_when_this_pcs_clock_has_not_reached_its_time() {
        let f = fixture();
        let sealed = f.before.seal(&f.key, &f.id).unwrap();
        // main destroyed it (another device did); a copy is judged by that, not by the clock.
        let new = scrub_sealed(&sealed, &f.key, &f.id, &f.main, NOW - 1_000_000).expect("destroyed in main");
        assert!(!has_secret(&Db::open(&f.key, &f.id, &new).unwrap().unwrap()));
    }

    #[test]
    fn a_backup_container_is_rebuilt_without_the_item() {
        let f = fixture();
        let sealed = f.before.seal(&f.key, &f.id).unwrap();
        let file = crate::vault_backup::build_container(&f.meta_json, &sealed);
        let new = scrub_container(&file, &f.key, &f.id, &f.main, NOW + 1).unwrap();
        let p = crate::vault_backup::parse_container(&new).unwrap();
        assert_eq!(p.meta_bytes, &f.meta_json[..], "the key file is untouched");
        assert!(!has_secret(&Db::open(&f.key, &f.id, p.db_bytes).unwrap().unwrap()));
        assert!(scrub_container(b"junk", &f.key, &f.id, &f.main, NOW + 1).is_none());
    }

    #[test]
    fn a_pass_cleans_every_kind_of_copy_and_nothing_else() {
        let f = fixture();
        let (root, data) = (tmp("root"), tmp("data"));
        let sealed_before = f.before.seal(&f.key, &f.id).unwrap();
        // The live database (already clean), rotating copies, the upgrade copy, a safety copy, kept folders.
        fs::write(root.join("vault.nqdb"), f.main.seal(&f.key, &f.id).unwrap()).unwrap();
        for n in ["vault.nqdb.bak.1", "vault.nqdb.bak.2", "vault.nqdb.v3.bak"] { fs::write(root.join(n), &sealed_before).unwrap(); }
        fs::write(root.join("notes.txt"), "keep me").unwrap();
        let sync_dir = data.join(crate::sync::state::SAFETY_DIR);
        fs::create_dir_all(&sync_dir).unwrap();
        let container = crate::vault_backup::build_container(&f.meta_json, &sealed_before);
        fs::write(sync_dir.join("safety-000000000000001-first-sync.nqbackup"), &container).unwrap();
        for d in ["before-merge-5", "before-restore-6"] {
            fs::create_dir_all(data.join(d)).unwrap();
            fs::write(data.join(d).join("vault.nqdb"), &sealed_before).unwrap();
            fs::write(data.join(d).join("vault.json"), &f.meta_json).unwrap();
        }
        // A copy of another vault, and a copy that never held the item.
        let (m2, k2, _) = create_vault("another-long-password-2", FAST).unwrap();
        let foreign = f.before.seal(&k2, &m2.vault_id_bytes().unwrap()).unwrap();
        fs::write(root.join("vault.nqdb.bak.3"), &foreign).unwrap();
        fs::create_dir_all(data.join("before-restore-7")).unwrap();
        fs::write(data.join("before-restore-7").join("vault.nqdb"), &foreign).unwrap();

        let r = scrub_local_copies(&root, &data, &f.key, &f.id, &f.main, NOW + 1);
        assert_eq!(r.rewritten, 6, "{r:?}: two rotating copies, the upgrade copy, a safety copy and two kept folders");
        assert_eq!(r.checked, 6, "{r:?}");
        for p in [root.join("vault.nqdb.bak.1"), root.join("vault.nqdb.bak.2"), root.join("vault.nqdb.v3.bak"), data.join("before-merge-5").join("vault.nqdb"), data.join("before-restore-6").join("vault.nqdb")] {
            let db = Db::open(&f.key, &f.id, &fs::read(&p).unwrap()).unwrap().unwrap();
            assert!(!has_secret(&db), "{p:?}");
            assert_eq!(live(&db, "mine.nqv").as_deref(), Some("my own note"), "{p:?}");
        }
        let safety_bytes = fs::read(sync_dir.join("safety-000000000000001-first-sync.nqbackup")).unwrap();
        let safety = crate::vault_backup::parse_container(&safety_bytes).unwrap();
        assert!(!has_secret(&Db::open(&f.key, &f.id, safety.db_bytes).unwrap().unwrap()));
        assert_eq!(fs::read(root.join("vault.nqdb.bak.3")).unwrap(), foreign, "another vault's copy is not ours");
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"keep me");
        assert_eq!(fs::read(data.join("before-restore-6").join("vault.json")).unwrap(), f.meta_json, "key files are untouched");
        // Doing it again changes nothing.
        let again = scrub_local_copies(&root, &data, &f.key, &f.id, &f.main, NOW + 1);
        assert_eq!((again.rewritten, again.markers_dropped), (0, 0));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn a_vault_with_nothing_destroyed_or_expiring_is_not_even_read() {
        let f = fixture();
        let (root, data) = (tmp("idle-root"), tmp("idle-data"));
        let mut plain = Db::new();
        plain.device = "dev".into();
        plain.put("a.nqv", "md", "a").unwrap();
        fs::write(root.join("vault.nqdb.bak.1"), plain.seal(&f.key, &f.id).unwrap()).unwrap();
        assert_eq!(scrub_local_copies(&root, &data, &f.key, &f.id, &plain, NOW), ScrubReport::default());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn the_markers_of_destroyed_items_are_dropped() {
        use crate::sync::markers::{self, Marker};
        use crate::vault_merge::ChangeKind;
        let f = fixture();
        let root = tmp("markers");
        let id_of = |p: &str| f.main.entries.values().find(|e| e.path == p).unwrap().id.clone();
        let mk = |id: String| Marker { id, kind: ChangeKind::Updated, from_device: "PC".into(), at: 1, before: None, before_copy: Some(markers::Kept { ext: "login".into(), content: "the shared secret v1".into() }) };
        markers::save(&root, &f.key, &f.id, vec![mk(id_of("shared.nqv")), mk(id_of("mine.nqv"))]).unwrap();
        let data = tmp("markers-data");
        let r = scrub_local_copies(&root, &data, &f.key, &f.id, &f.main, NOW + 1);
        assert_eq!(r.markers_dropped, 1);
        let left = markers::load(&root, &f.key, &f.id);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, id_of("mine.nqv"));
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(data);
    }

    #[test]
    fn destroying_an_item_in_the_live_vault_queues_a_pass_that_cleans_the_old_copies() {
        let dir = tmp("live");
        let (meta, key, _) = create_vault("a-long-test-password-1", FAST).unwrap();
        let id = meta.vault_id_bytes().unwrap();
        let vs = crate::vault::VaultState::default();
        vs.ensure_device(&dir);
        vs.set_root(dir.clone());
        vs.install_key(key.clone(), id);
        vs.with_db(|db, _, _, _| { db.put("mine.nqv", "md", "my own note")?; db.put("shared.nqv", "md", "the shared secret")?; Ok(((), true)) }).unwrap();
        // An older copy of the vault that holds the item, as the rotating backup would.
        let old = vs.with_db(|db, _, _, _| Ok((db.seal(&key, &id).unwrap(), false))).unwrap();
        fs::write(dir.join("vault.nqdb.bak.1"), &old).unwrap();
        assert!(!vs.take_scrub_needed(), "nothing destroyed yet");
        // The item's time has come; the next access destroys it and a pass becomes due.
        let past = vdb::now_ms() - 1;
        vs.with_db(|db, _, _, _| { db.entries.values_mut().find(|e| e.path == "shared.nqv").unwrap().expires_at = Some(past); Ok(((), true)) }).unwrap();
        vs.with_db(|db, _, _, _| Ok((db.entries.values().filter(|e| e.deleted).count(), false))).unwrap();
        assert!(vs.take_scrub_needed(), "a destroyed item queues the cleaning");
        assert!(!vs.take_scrub_needed(), "and only once");
        let r = vs.scrub_local_copies(&dir).unwrap();
        assert_eq!(r.rewritten, 1, "{r:?}");
        let back = Db::open(&key, &id, &fs::read(dir.join("vault.nqdb.bak.1")).unwrap()).unwrap().unwrap();
        assert!(!has_secret(&back) && !back.entries.values().any(|e| e.content.contains("the shared secret")));
        assert_eq!(live(&back, "mine.nqv").as_deref(), Some("my own note"));
        // A vault opened again that holds destroyed items queues a pass too (the flag may have been lost with a restart).
        vs.set_root(tmp("elsewhere"));
        vs.set_root(dir.clone());
        vs.with_db(|_, _, _, _| Ok(((), false))).unwrap();
        assert!(vs.take_scrub_needed(), "loaded holding destroyed items");
        let _ = fs::remove_dir_all(dir);
    }
}
