//! The Secure Vault database: every locked note lives in ONE encrypted file
//! (`vault.nqdb`), so there is a single source of truth to back up and sync.
//!
//! This module is pure (no Tauri, no network): the in-memory [`Db`], its
//! sealed on-disk form, path handling and the entry-level three-way [`merge`]
//! used by sync. File names, folders and contents are all inside the sealed
//! payload; the provider only ever sees one opaque blob.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::vault_core::{self as vc, VaultKey, VAULT_ID_LEN};

pub const DB_FILE: &str = "vault.nqdb";
/// `ext` stored (authenticated) in the sealed header, to tell a DB from a legacy manifest.
pub const DB_EXT: &str = "db";
const BAK_PREFIX: &str = "vault.nqdb.bak";
const BAK_KEEP: usize = 3;
const BAK_EVERY_SECS: u64 = 10 * 60;
const NQV: &str = ".nqv";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    /// Relative path with `/`; files end in `.nqv`, folders have no suffix.
    pub path: String,
    /// Original file type ("md", "login", "ssh", …). Empty for folders.
    #[serde(default)]
    pub ext: String,
    #[serde(default)]
    pub content: String,
    /// Unix milliseconds of the last change.
    pub updated: u64,
    /// Tombstone: kept so deletions reach other devices; content is cleared.
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub dir: bool,
}

impl Entry {
    /// Content fingerprint (everything except the id and timestamp).
    pub fn hash(&self) -> String {
        let mut h = Sha256::new();
        for part in [self.path.as_str(), &self.ext, &self.content] {
            h.update(part.as_bytes());
            h.update([0]);
        }
        h.update([self.deleted as u8, self.dir as u8]);
        h.finalize().iter().map(|b| format!("{b:02x}")).collect()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct Db {
    #[serde(default)]
    pub v: u32,
    #[serde(default)]
    pub entries: BTreeMap<String, Entry>,
    /// Set once the old per-note `.nqv` files have been imported on this vault.
    #[serde(default)]
    pub legacy_imported: bool,
}

impl Drop for Db {
    fn drop(&mut self) {
        for e in self.entries.values_mut() {
            e.content.zeroize();
        }
    }
}

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct ListItem {
    pub rel: String,
    pub ext: String,
    pub updated: u64,
    pub dir: bool,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ─── paths ───────────────────────────────────────────────────────────────────

/// A plain relative path: no `..`, no absolute prefix, no backslash or drive colon.
pub fn valid_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.contains(':')
        && rel.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// `<root>/a/b.nqv` → `a/b.nqv` (case-insensitive prefix match, `\` or `/`).
pub fn rel_from_full(root: &Path, full: &str) -> Result<String, String> {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    let (r, f) = (norm(&root.to_string_lossy()), norm(full));
    let rest = f
        .get(..r.len())
        .filter(|p| p.eq_ignore_ascii_case(&r))
        .and_then(|_| f[r.len()..].strip_prefix('/'))
        .ok_or("That path is outside the vault folder")?;
    if !valid_rel(rest) {
        return Err("Invalid vault path".into());
    }
    Ok(rest.to_string())
}

fn stem_of(rel: &str) -> &str {
    rel.strip_suffix(NQV).or_else(|| rel.strip_suffix(".NQV")).unwrap_or(rel)
}

fn conflict_path(rel: &str, tag: &str, n: u64) -> String {
    format!("{} ({tag} {n}){NQV}", stem_of(rel))
}

fn parent_dirs(rel: &str) -> impl Iterator<Item = String> + '_ {
    rel.match_indices('/').map(move |(i, _)| rel[..i].to_string())
}

// ─── operations ──────────────────────────────────────────────────────────────

impl Db {
    pub fn new() -> Self {
        let mut d = Db::default();
        d.v = 1;
        d
    }

    fn live_id(&self, rel: &str, dir: bool) -> Option<&str> {
        self.entries.values().find(|e| !e.deleted && e.dir == dir && e.path == rel).map(|e| e.id.as_str())
    }

    pub fn get(&self, rel: &str) -> Option<&Entry> {
        self.live_id(rel, false).and_then(|id| self.entries.get(id))
    }

    /// Create or replace the file at `rel`.
    pub fn put(&mut self, rel: &str, ext: &str, content: &str) -> Result<(), String> {
        if !valid_rel(rel) || !rel.to_ascii_lowercase().ends_with(NQV) {
            return Err("Invalid vault path".into());
        }
        if self.live_id(rel, true).is_some() {
            return Err("A folder with that name already exists".into());
        }
        let id = self.live_id(rel, false).map(str::to_string).unwrap_or_else(new_id);
        let e = self.entries.entry(id.clone()).or_insert_with(|| Entry {
            id, path: rel.into(), ext: String::new(), content: String::new(), updated: 0, deleted: false, dir: false,
        });
        e.ext = ext.into();
        e.content.zeroize();
        e.content = content.into();
        e.updated = now_ms();
        Ok(())
    }

    pub fn mkdir(&mut self, rel: &str) -> Result<(), String> {
        if !valid_rel(rel) || rel.to_ascii_lowercase().ends_with(NQV) {
            return Err("Invalid folder name".into());
        }
        if self.live_id(rel, true).is_some() { return Ok(()); }
        if self.live_id(rel, false).is_some() { return Err("A note with that name already exists".into()); }
        let id = new_id();
        self.entries.insert(id.clone(), Entry {
            id, path: rel.into(), ext: String::new(), content: String::new(), updated: now_ms(), deleted: false, dir: true,
        });
        Ok(())
    }

    /// Delete a note, or a folder with everything in it (tombstones, so it syncs).
    pub fn delete(&mut self, rel: &str) -> Result<(), String> {
        let prefix = format!("{rel}/");
        let now = now_ms();
        let mut hit = false;
        for e in self.entries.values_mut().filter(|e| !e.deleted) {
            if e.path == rel || (e.path.starts_with(&prefix)) {
                e.deleted = true;
                e.content.zeroize();
                e.content = String::new();
                e.updated = now;
                hit = true;
            }
        }
        if hit { Ok(()) } else { Err("Nothing to delete".into()) }
    }

    /// Rename/move a note or folder (a folder carries everything under it).
    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        if !valid_rel(to) { return Err("Invalid vault path".into()); }
        if from == to { return Ok(()); }
        let is_file = self.live_id(from, false).is_some();
        if is_file && !to.to_ascii_lowercase().ends_with(NQV) {
            return Err("A note must keep the .nqv extension".into());
        }
        if self.entries.values().any(|e| !e.deleted && e.path == to) {
            return Err("Something with that name already exists".into());
        }
        let prefix = format!("{from}/");
        let now = now_ms();
        let mut hit = false;
        for e in self.entries.values_mut().filter(|e| !e.deleted) {
            if e.path == from {
                e.path = to.into();
                e.updated = now;
                hit = true;
            } else if let Some(rest) = e.path.strip_prefix(&prefix) {
                e.path = format!("{to}/{rest}");
                e.updated = now;
                hit = true;
            }
        }
        if hit { Ok(()) } else { Err("Nothing to rename".into()) }
    }

    /// Notes and folders (explicit and implied by note paths), folders first by path order.
    pub fn list(&self) -> Vec<ListItem> {
        let mut dirs: BTreeMap<String, u64> = BTreeMap::new();
        let mut out = vec![];
        for e in self.entries.values().filter(|e| !e.deleted) {
            if e.dir {
                for d in parent_dirs(&e.path) { dirs.entry(d).or_insert(0); }
                dirs.insert(e.path.clone(), e.updated);
            } else {
                for d in parent_dirs(&e.path) { dirs.entry(d).or_insert(0); }
                out.push(ListItem { rel: e.path.clone(), ext: e.ext.clone(), updated: e.updated, dir: false });
            }
        }
        for (d, updated) in dirs {
            out.push(ListItem { rel: d, ext: String::new(), updated, dir: true });
        }
        out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        out
    }

    /// id → fingerprint of every entry (the merge base after a sync).
    pub fn fingerprints(&self) -> HashMap<String, String> {
        self.entries.iter().map(|(k, e)| (k.clone(), e.hash())).collect()
    }
}

// ─── sealed form ─────────────────────────────────────────────────────────────

impl Db {
    pub fn seal(&self, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN]) -> Result<Vec<u8>, String> {
        let json = zeroize::Zeroizing::new(serde_json::to_vec(self).map_err(|e| e.to_string())?);
        vc::seal(key, vault_id, DB_EXT, &json).map_err(|e| e.to_string())
    }

    /// `Ok(None)` when `bytes` is a sealed payload of another kind (a legacy sync manifest).
    pub fn open(key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], bytes: &[u8]) -> Result<Option<Db>, String> {
        let (ext, plain) = vc::open(key, vault_id, bytes).map_err(|e| e.to_string())?;
        if ext != DB_EXT { return Ok(None); }
        serde_json::from_slice(&plain).map(Some).map_err(|_| "The vault database is corrupted".to_string())
    }
}

// ─── on disk ─────────────────────────────────────────────────────────────────

pub fn db_path(root: &Path) -> PathBuf {
    root.join(DB_FILE)
}

fn bak_path(root: &Path, n: usize) -> PathBuf {
    root.join(format!("{BAK_PREFIX}.{n}"))
}

fn mtime_secs(p: &Path) -> Option<u64> {
    fs::metadata(p).ok()?.modified().ok()?.duration_since(SystemTime::UNIX_EPOCH).ok().map(|d| d.as_secs())
}

/// Loads `<root>/vault.nqdb`; a missing file is a fresh, empty database.
/// If the file is unreadable it falls back to the newest backup that opens.
pub fn load(root: &Path, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN]) -> Result<Db, String> {
    let main = db_path(root);
    match fs::read(&main) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Db::new()),
        Err(e) => return Err(e.to_string()),
        Ok(b) => match Db::open(key, vault_id, &b) {
            Ok(Some(db)) => return Ok(db),
            Ok(None) => return Err("vault.nqdb isn't a vault database".into()),
            Err(main_err) => {
                for n in 1..=BAK_KEEP {
                    if let Ok(b) = fs::read(bak_path(root, n)) {
                        if let Ok(Some(db)) = Db::open(key, vault_id, &b) { return Ok(db); }
                    }
                }
                return Err(format!("Couldn't open vault.nqdb ({main_err}) and no usable backup was found"));
            }
        },
    }
}

/// Atomically writes the sealed DB. Before replacing a healthy file, the old one is
/// rotated into `vault.nqdb.bak.1..3` (at most every 10 minutes) so a bad write or a
/// bad sync can always be rolled back.
pub fn save(root: &Path, bytes: &[u8]) -> Result<(), String> {
    let main = db_path(root);
    if main.exists() {
        let due = mtime_secs(&bak_path(root, 1)).map(|t| now_ms() / 1000 >= t + BAK_EVERY_SECS).unwrap_or(true);
        if due {
            for n in (1..BAK_KEEP).rev() {
                let _ = fs::rename(bak_path(root, n), bak_path(root, n + 1));
            }
            let _ = fs::copy(&main, bak_path(root, 1));
        }
    }
    crate::vault::atomic_write(&main, bytes)
}

// ─── merge ───────────────────────────────────────────────────────────────────

#[derive(Debug, Default, PartialEq)]
pub struct MergeStats {
    /// Entries whose content on this device changed because of the remote copy.
    pub pulled: u32,
    /// Entries edited on both devices (the older version was kept as a "(conflict …)" note).
    pub conflicts: u32,
}

/// Entry-level three-way merge of `remote` into `local`. `base` maps entry id → hash
/// as of the last successful sync. The result keeps every entry from both sides; a
/// delete never beats a later edit; same-entry edits on both sides keep the newer one
/// and save the other beside it as a conflict note.
pub fn merge(local: &Db, remote: &Db, base: &HashMap<String, String>) -> (Db, MergeStats) {
    let mut out = Db::new();
    out.legacy_imported = local.legacy_imported || remote.legacy_imported;
    let mut stats = MergeStats::default();
    let mut extra: Vec<Entry> = vec![];
    let ids: BTreeSet<&String> = local.entries.keys().chain(remote.entries.keys()).collect();
    for id in ids {
        let chosen = match (local.entries.get(id), remote.entries.get(id)) {
            (Some(l), None) => l.clone(),
            (None, Some(r)) => { stats.pulled += !r.deleted as u32; r.clone() }
            (Some(l), Some(r)) => {
                let (lh, rh) = (l.hash(), r.hash());
                let b = base.get(id).map(String::as_str);
                if lh == rh {
                    if l.updated >= r.updated { l.clone() } else { r.clone() }
                } else if b == Some(rh.as_str()) {
                    l.clone() // only this device changed it
                } else if b == Some(lh.as_str()) {
                    stats.pulled += 1;
                    r.clone() // only the other device changed it
                } else if l.deleted != r.deleted {
                    // edit beats delete
                    let live = if l.deleted { r } else { l };
                    if l.deleted { stats.pulled += 1; }
                    live.clone()
                } else {
                    let (win, lose) = if l.updated >= r.updated { (l, r) } else { (r, l) };
                    if !win.deleted && !lose.deleted && !lose.dir {
                        stats.conflicts += 1;
                        let mut c = lose.clone();
                        c.id = new_id();
                        c.path = conflict_path(&lose.path, "conflict", lose.updated / 1000);
                        extra.push(c);
                    }
                    if std::ptr::eq(win, r) { stats.pulled += 1; }
                    win.clone()
                }
            }
            (None, None) => continue,
        };
        out.entries.insert(chosen.id.clone(), chosen);
    }
    for c in extra { out.entries.insert(c.id.clone(), c); }
    dedupe_paths(&mut out, &mut stats);
    (out, stats)
}

/// Two devices can each create a note at the same path; keep the newest in place and
/// move the others to a "(copy …)" name so nothing is hidden or overwritten.
fn dedupe_paths(db: &mut Db, stats: &mut MergeStats) {
    let mut by_path: BTreeMap<(String, bool), Vec<(u64, String)>> = BTreeMap::new();
    for e in db.entries.values().filter(|e| !e.deleted) {
        by_path.entry((e.path.clone(), e.dir)).or_default().push((e.updated, e.id.clone()));
    }
    for ((_, dir), mut v) in by_path {
        if v.len() < 2 { continue; }
        v.sort_by(|a, b| b.cmp(a)); // newest first stays put
        for (n, (_, id)) in v.into_iter().enumerate().skip(1) {
            let e = db.entries.get_mut(&id).expect("id from the same map");
            if dir {
                e.deleted = true; // duplicate empty folders just collapse
            } else {
                e.path = conflict_path(&e.path, "copy", n as u64);
                stats.conflicts += 1;
            }
        }
    }
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_core::{create_vault, KdfParams};

    fn keys() -> (VaultKey, [u8; VAULT_ID_LEN]) {
        let (meta, key, _) = create_vault("a-long-test-password-1", KdfParams::default()).unwrap();
        (key, meta.vault_id_bytes().unwrap())
    }

    #[test]
    fn put_get_list_rename_delete() {
        let mut db = Db::new();
        db.put("SSH/srv.nqv", "ssh", "secret").unwrap();
        db.put("a.nqv", "md", "hi").unwrap();
        assert_eq!(db.get("a.nqv").unwrap().content, "hi");
        let l = db.list();
        assert_eq!(l.iter().map(|i| (i.rel.as_str(), i.dir)).collect::<Vec<_>>(), vec![("a.nqv", false), ("SSH", true), ("SSH/srv.nqv", false)]);
        db.rename("SSH", "Servers").unwrap();
        assert!(db.get("Servers/srv.nqv").is_some() && db.get("SSH/srv.nqv").is_none());
        db.delete("Servers").unwrap();
        assert!(db.get("Servers/srv.nqv").is_none());
        assert!(db.put("../x.nqv", "md", "").is_err() && db.put("a.txt", "md", "").is_err());
    }

    #[test]
    fn put_overwrites_in_place_and_keeps_the_id() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "1").unwrap();
        let id = db.get("a.nqv").unwrap().id.clone();
        db.put("a.nqv", "md", "2").unwrap();
        assert_eq!(db.entries.len(), 1);
        assert_eq!(db.get("a.nqv").unwrap().id, id);
    }

    #[test]
    fn sealed_round_trip_and_wrong_vault() {
        let (k, id) = keys();
        let mut db = Db::new();
        db.put("a.nqv", "md", "hello").unwrap();
        let bytes = db.seal(&k, &id).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("hello") && !String::from_utf8_lossy(&bytes).contains("a.nqv"));
        let back = Db::open(&k, &id, &bytes).unwrap().unwrap();
        assert_eq!(back.get("a.nqv").unwrap().content, "hello");
        let (k2, id2) = keys();
        assert!(Db::open(&k2, &id2, &bytes).is_err());
    }

    #[test]
    fn rel_from_full_strips_root_and_rejects_outside() {
        let root = Path::new("C:/Users/me/Notiq Vault");
        assert_eq!(rel_from_full(root, "C:\\Users\\me\\notiq vault\\SSH\\a.nqv").unwrap(), "SSH/a.nqv");
        assert!(rel_from_full(root, "C:/Users/me/other/a.nqv").is_err());
        assert!(rel_from_full(root, "C:/Users/me/Notiq Vault/../a.nqv").is_err());
    }

    fn clone_edit(db: &Db, rel: &str, content: &str, ms: u64) -> Db {
        let mut d = db.clone();
        let id = d.get(rel).unwrap().id.clone();
        let e = d.entries.get_mut(&id).unwrap();
        e.content = content.into();
        e.updated = ms;
        d
    }

    #[test]
    fn merge_unions_new_entries_both_ways() {
        let mut a = Db::new(); a.put("a.nqv", "md", "A").unwrap();
        let mut b = Db::new(); b.put("b.nqv", "md", "B").unwrap();
        let (m, s) = merge(&a, &b, &HashMap::new());
        assert!(m.get("a.nqv").is_some() && m.get("b.nqv").is_some());
        assert_eq!(s, MergeStats { pulled: 1, conflicts: 0 });
    }

    #[test]
    fn merge_takes_the_side_that_changed_since_base() {
        let mut base = Db::new(); base.put("a.nqv", "md", "v1").unwrap();
        let bf = base.fingerprints();
        let remote = clone_edit(&base, "a.nqv", "v2", 5);
        let (m, s) = merge(&base, &remote, &bf);
        assert_eq!(m.get("a.nqv").unwrap().content, "v2");
        assert_eq!((s.pulled, s.conflicts), (1, 0));
        let (m, _) = merge(&remote, &base, &bf);
        assert_eq!(m.get("a.nqv").unwrap().content, "v2"); // only local changed
    }

    #[test]
    fn merge_both_changed_keeps_newer_and_a_conflict_copy() {
        let mut base = Db::new(); base.put("a.nqv", "md", "v1").unwrap();
        let bf = base.fingerprints();
        let l = clone_edit(&base, "a.nqv", "local", u64::MAX / 2);
        let r = clone_edit(&base, "a.nqv", "remote", 10);
        let (m, s) = merge(&l, &r, &bf);
        assert_eq!(m.get("a.nqv").unwrap().content, "local");
        assert_eq!(s.conflicts, 1);
        assert!(m.list().iter().any(|i| i.rel.contains("(conflict")));
    }

    #[test]
    fn merge_delete_propagates_but_loses_to_a_concurrent_edit() {
        let mut base = Db::new(); base.put("a.nqv", "md", "v1").unwrap();
        let bf = base.fingerprints();
        let mut deleted = base.clone(); deleted.delete("a.nqv").unwrap();
        let (m, _) = merge(&base, &deleted, &bf);
        assert!(m.get("a.nqv").is_none(), "remote delete reaches local");
        let edited = clone_edit(&base, "a.nqv", "edited", 99);
        let (m, _) = merge(&edited, &deleted, &bf);
        assert_eq!(m.get("a.nqv").unwrap().content, "edited");
    }

    #[test]
    fn same_path_created_on_two_devices_keeps_both() {
        let mut a = Db::new(); a.put("n.nqv", "md", "A").unwrap();
        let mut b = Db::new(); b.put("n.nqv", "md", "B").unwrap();
        let (m, s) = merge(&a, &b, &HashMap::new());
        assert_eq!(m.list().iter().filter(|i| !i.dir).count(), 2);
        assert_eq!(s.conflicts, 1);
    }

    #[test]
    fn disk_load_falls_back_to_backup_when_main_is_corrupt() {
        let (k, id) = keys();
        let dir = std::env::temp_dir().join(format!("nqdb-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        let mut db = Db::new(); db.put("a.nqv", "md", "x").unwrap();
        save(&dir, &db.seal(&k, &id).unwrap()).unwrap();
        db.put("a.nqv", "md", "y").unwrap();
        // rotation is rate-limited, so force a backup by copying manually
        fs::copy(db_path(&dir), bak_path(&dir, 1)).unwrap();
        fs::write(db_path(&dir), b"garbage").unwrap();
        assert_eq!(load(&dir, &k, &id).unwrap().get("a.nqv").unwrap().content, "x");
        fs::remove_dir_all(&dir).ok();
    }
}
