//! The Secure Vault database: every locked note lives in ONE encrypted file
//! (`vault.nqdb`), a single source of truth that stays on this device.
//!
//! This module is pure (no Tauri, no network): the in-memory [`Db`], its
//! sealed on-disk form and path handling. File names, folders and contents are
//! all inside the sealed payload.

use std::{
    collections::{BTreeMap},
    fs,
    path::{Path, PathBuf},
    time::SystemTime,
};

use rand::RngCore;
use serde::{Deserialize, Serialize};
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
    /// User tags (normalised, lowercase, no leading `#`).
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub starred: bool,
    /// Unix ms when moved to the recycle bin; `Some` = trashed (hidden from normal views).
    #[serde(default)]
    pub trashed_at: Option<u64>,
}

impl Entry {
    /// A live (not tombstoned, not trashed) entry.
    pub fn is_live(&self) -> bool {
        !self.deleted && self.trashed_at.is_none()
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
    pub tags: Vec<String>,
    pub starred: bool,
    pub trashed_at: Option<u64>,
}

fn item(e: &Entry) -> ListItem {
    ListItem {
        rel: e.path.clone(), ext: e.ext.clone(), updated: e.updated, dir: e.dir,
        tags: e.tags.clone(), starred: e.starred, trashed_at: e.trashed_at,
    }
}

/// How long a trashed entry is kept before it is purged for good.
pub const TRASH_KEEP_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const MAX_TAGS: usize = 20;
const MAX_TAG_LEN: usize = 32;

/// trim, strip leading '#', lowercase, drop control chars/empties, cap length, dedupe, cap count.
pub fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for t in tags {
        let t: String = t.trim().trim_start_matches('#').trim().chars().filter(|c| !c.is_control()).collect();
        let t: String = t.to_lowercase().chars().take(MAX_TAG_LEN).collect::<String>().trim().to_string();
        if t.is_empty() || out.contains(&t) { continue; }
        out.push(t);
        if out.len() == MAX_TAGS { break; }
    }
    out
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

fn variant_path(rel: &str, tag: &str, n: u64, file: bool) -> String {
    let base = if file { stem_of(rel) } else { rel };
    let name = if n <= 1 { format!("{base} ({tag})") } else { format!("{base} ({tag} {n})") };
    if file { format!("{name}{NQV}") } else { name }
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
        self.entries.values().find(|e| e.is_live() && e.dir == dir && e.path == rel).map(|e| e.id.as_str())
    }

    /// Is something live at `path` or below it (a note, a folder, or an implied folder)?
    fn occupied(&self, path: &str) -> bool {
        let prefix = format!("{path}/");
        self.entries.values().any(|e| e.is_live() && (e.path == path || e.path.starts_with(&prefix)))
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
            tags: vec![], starred: false, trashed_at: None,
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
            tags: vec![], starred: false, trashed_at: None,
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
        if self.entries.values().any(|e| e.is_live() && e.path == to) {
            return Err("Something with that name already exists".into());
        }
        let prefix = format!("{from}/");
        let now = now_ms();
        let mut hit = false;
        for e in self.entries.values_mut().filter(|e| e.is_live()) {
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
    /// Tombstoned and trashed entries are not shown.
    pub fn list(&self) -> Vec<ListItem> {
        let mut dirs: BTreeMap<String, ListItem> = BTreeMap::new();
        let mut out = vec![];
        let blank = |rel: &str| ListItem { rel: rel.into(), ext: String::new(), updated: 0, dir: true, tags: vec![], starred: false, trashed_at: None };
        for e in self.entries.values().filter(|e| e.is_live()) {
            for d in parent_dirs(&e.path) { dirs.entry(d.clone()).or_insert_with(|| blank(&d)); }
            if e.dir { dirs.insert(e.path.clone(), item(e)); } else { out.push(item(e)); }
        }
        out.extend(dirs.into_values());
        out.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        out
    }

    /// Everything in the recycle bin. A trashed folder is one `dir` item (synthesised when it
    /// was only implied by note paths) with its trashed children listed under their rel paths.
    pub fn list_trash(&self) -> Vec<ListItem> {
        let mut out: BTreeMap<(String, bool), ListItem> = BTreeMap::new();
        let mut implied: BTreeMap<String, u64> = BTreeMap::new();
        for e in self.entries.values().filter(|e| !e.deleted && e.trashed_at.is_some()) {
            out.insert((e.path.clone(), e.dir), item(e));
            for d in parent_dirs(&e.path) {
                let t = implied.entry(d).or_insert(0);
                *t = (*t).max(e.trashed_at.unwrap_or(0));
            }
        }
        for (d, t) in implied {
            if out.contains_key(&(d.clone(), true)) || self.occupied(&d) { continue; }
            out.insert((d.clone(), true), ListItem { rel: d, ext: String::new(), updated: t, dir: true, tags: vec![], starred: false, trashed_at: Some(t) });
        }
        let mut v: Vec<ListItem> = out.into_values().collect();
        v.sort_by(|a, b| a.rel.to_lowercase().cmp(&b.rel.to_lowercase()));
        v
    }

    fn live_ids_under(&self, rel: &str) -> Vec<String> {
        let prefix = format!("{rel}/");
        self.entries.values().filter(|e| e.is_live() && (e.path == rel || e.path.starts_with(&prefix))).map(|e| e.id.clone()).collect()
    }

    /// Move a note, or a folder and everything in it, to the recycle bin.
    pub fn trash(&mut self, rel: &str) -> Result<(), String> {
        self.trash_at(rel, now_ms())
    }

    pub fn trash_at(&mut self, rel: &str, now: u64) -> Result<(), String> {
        let ids = self.live_ids_under(rel);
        if ids.is_empty() { return Err("Nothing to delete".into()); }
        for id in ids {
            if let Some(e) = self.entries.get_mut(&id) { e.trashed_at = Some(now); }
        }
        Ok(())
    }

    /// Take a note, or a folder tree, back out of the recycle bin. If its path is taken by
    /// something live, it comes back as "<name> (restored)".
    pub fn restore(&mut self, rel: &str) -> Result<(), String> {
        let prefix = format!("{rel}/");
        let mut ids: Vec<(String, String)> = self.entries.values()
            .filter(|e| !e.deleted && e.trashed_at.is_some() && (e.path == rel || e.path.starts_with(&prefix)))
            .map(|e| (e.path.clone(), e.id.clone())).collect();
        if ids.is_empty() { return Err("Nothing to restore".into()); }
        ids.sort();
        let folder = ids.iter().any(|(_, id)| { let e = &self.entries[id]; e.dir || e.path != rel });
        let root = if folder && self.occupied(rel) {
            (1u64..).map(|n| variant_path(rel, "restored", n, false)).find(|c| !self.occupied(c)).expect("unbounded")
        } else {
            rel.to_string()
        };
        for (path, id) in ids {
            let mut np = match path.strip_prefix(rel) { Some(rest) => format!("{root}{rest}"), None => path.clone() };
            let is_dir = self.entries[&id].dir;
            if !is_dir && self.occupied(&np) {
                np = (1u64..).map(|n| variant_path(&np, "restored", n, true)).find(|c| !self.occupied(c)).expect("unbounded");
            }
            let e = self.entries.get_mut(&id).expect("id from the same map");
            e.path = np;
            e.trashed_at = None;
        }
        Ok(())
    }

    fn remove_where(&mut self, f: impl Fn(&Entry) -> bool) -> usize {
        let ids: Vec<String> = self.entries.values().filter(|e| f(e)).map(|e| e.id.clone()).collect();
        for id in &ids {
            if let Some(mut e) = self.entries.remove(id) { e.content.zeroize(); }
        }
        ids.len()
    }

    /// Permanently remove a TRASHED note or folder tree (no tombstone). Live entries are never touched.
    pub fn purge(&mut self, rel: &str) -> Result<(), String> {
        let prefix = format!("{rel}/");
        let n = self.remove_where(|e| e.trashed_at.is_some() && (e.path == rel || e.path.starts_with(&prefix)));
        if n == 0 { Err("Only items in the recycle bin can be deleted permanently".into()) } else { Ok(()) }
    }

    pub fn empty_trash(&mut self) -> usize {
        self.remove_where(|e| e.trashed_at.is_some())
    }

    /// Permanently drop entries trashed more than 30 days before `now`.
    pub fn purge_expired(&mut self, now: u64) -> usize {
        self.remove_where(|e| e.trashed_at.map(|t| now.saturating_sub(t) > TRASH_KEEP_MS).unwrap_or(false))
    }

    /// Drop legacy sync tombstones (nothing syncs any more).
    pub fn drop_tombstones(&mut self) -> usize {
        self.remove_where(|e| e.deleted)
    }

    pub fn set_tags(&mut self, rel: &str, tags: Vec<String>) -> Result<(), String> {
        let tags = normalize_tags(tags);
        let id = self.live_id(rel, false).or_else(|| self.live_id(rel, true)).ok_or("Nothing to tag")?.to_string();
        self.entries.get_mut(&id).expect("live id").tags = tags;
        Ok(())
    }

    pub fn set_starred(&mut self, rel: &str, starred: bool) -> Result<(), String> {
        let id = self.live_id(rel, false).or_else(|| self.live_id(rel, true)).ok_or("Nothing to star")?.to_string();
        self.entries.get_mut(&id).expect("live id").starred = starred;
        Ok(())
    }

    /// Copy a note to "<name> (copy).nqv" (then "(copy 2)" …); returns the new rel path.
    pub fn duplicate(&mut self, rel: &str) -> Result<String, String> {
        let src = self.get(rel).ok_or("Only notes can be duplicated")?.clone();
        let to = (1u64..).map(|n| variant_path(rel, "copy", n, true)).find(|c| !self.occupied(c)).expect("unbounded");
        self.put(&to, &src.ext, &src.content)?;
        self.set_tags(&to, src.tags.clone())?;
        Ok(to)
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

/// After loading: forget legacy tombstones and purge anything trashed over 30 days ago.
fn tidy(mut db: Db) -> Db {
    db.drop_tombstones();
    db.purge_expired(now_ms());
    db
}

/// Loads `<root>/vault.nqdb`; a missing file is a fresh, empty database.
/// If the file is unreadable it falls back to the newest backup that opens.
pub fn load(root: &Path, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN]) -> Result<Db, String> {
    let main = db_path(root);
    match fs::read(&main) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Db::new()),
        Err(e) => return Err(e.to_string()),
        Ok(b) => match Db::open(key, vault_id, &b) {
            Ok(Some(db)) => return Ok(tidy(db)),
            Ok(None) => return Err("vault.nqdb isn't a vault database".into()),
            Err(main_err) => {
                for n in 1..=BAK_KEEP {
                    if let Ok(b) = fs::read(bak_path(root, n)) {
                        if let Ok(Some(db)) = Db::open(key, vault_id, &b) { return Ok(tidy(db)); }
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

    fn rels(items: Vec<ListItem>) -> Vec<String> { items.into_iter().map(|i| i.rel).collect() }

    #[test]
    fn trash_and_restore_a_file() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "hi").unwrap();
        db.trash("a.nqv").unwrap();
        assert!(db.get("a.nqv").is_none() && db.list().is_empty());
        let t = db.list_trash();
        assert_eq!(rels(t.clone()), vec!["a.nqv"]);
        assert!(t[0].trashed_at.is_some());
        assert!(db.rename("a.nqv", "b.nqv").is_err(), "trashed sources can't be renamed");
        assert!(db.trash("a.nqv").is_err(), "already trashed");
        db.restore("a.nqv").unwrap();
        assert_eq!(db.get("a.nqv").unwrap().content, "hi");
        assert!(db.list_trash().is_empty());
    }

    #[test]
    fn trash_and_restore_a_folder_tree() {
        let mut db = Db::new();
        db.mkdir("F").unwrap();
        db.put("F/a.nqv", "md", "1").unwrap();
        db.put("F/sub/b.nqv", "md", "2").unwrap();
        db.put("keep.nqv", "md", "k").unwrap();
        db.trash("F").unwrap();
        assert_eq!(rels(db.list()), vec!["keep.nqv"]);
        let t = db.list_trash();
        assert_eq!(rels(t.clone()), vec!["F", "F/a.nqv", "F/sub", "F/sub/b.nqv"]);
        assert!(t.iter().find(|i| i.rel == "F").unwrap().dir && t.iter().find(|i| i.rel == "F/sub").unwrap().dir);
        db.restore("F").unwrap();
        assert!(db.list_trash().is_empty());
        assert_eq!(db.get("F/sub/b.nqv").unwrap().content, "2");
        assert!(rels(db.list()).contains(&"F".to_string()));
    }

    #[test]
    fn restoring_one_file_from_a_trashed_implied_folder_brings_the_folder_back() {
        let mut db = Db::new();
        db.put("F/a.nqv", "md", "1").unwrap();
        db.put("F/b.nqv", "md", "2").unwrap();
        db.trash("F").unwrap();
        db.restore("F/a.nqv").unwrap();
        assert_eq!(rels(db.list()), vec!["F", "F/a.nqv"]);
        assert_eq!(rels(db.list_trash()), vec!["F/b.nqv"]);
    }

    #[test]
    fn restore_collision_renames_the_restored_entry() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "old").unwrap();
        db.trash("a.nqv").unwrap();
        db.put("a.nqv", "md", "new").unwrap(); // does not revive the trashed one
        assert_eq!(db.entries.len(), 2);
        assert_eq!(db.get("a.nqv").unwrap().content, "new");
        db.restore("a.nqv").unwrap();
        assert_eq!(db.get("a.nqv").unwrap().content, "new");
        assert_eq!(db.get("a (restored).nqv").unwrap().content, "old");
        db.put("a.nqv", "md", "newer").unwrap();
        db.trash("a (restored).nqv").unwrap();
        db.put("a (restored).nqv", "md", "x").unwrap();
        db.restore("a (restored).nqv").unwrap();
        assert_eq!(db.get("a (restored) (restored).nqv").unwrap().content, "old");

        let mut db = Db::new();
        db.put("F/x.nqv", "md", "old").unwrap();
        db.trash("F").unwrap();
        db.put("F/y.nqv", "md", "live").unwrap();
        db.restore("F").unwrap();
        assert_eq!(db.get("F (restored)/x.nqv").unwrap().content, "old");
        assert_eq!(db.get("F/y.nqv").unwrap().content, "live");
    }

    #[test]
    fn purge_only_works_on_trashed() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "1").unwrap();
        db.put("F/b.nqv", "md", "2").unwrap();
        assert!(db.purge("a.nqv").is_err());
        assert_eq!(db.entries.len(), 2);
        db.trash("a.nqv").unwrap();
        db.purge("a.nqv").unwrap();
        assert_eq!(db.entries.len(), 1, "removed outright, no tombstone");
        db.trash("F").unwrap();
        db.purge("F").unwrap();
        assert!(db.entries.is_empty());
    }

    #[test]
    fn empty_trash_removes_only_trashed() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "1").unwrap();
        db.put("b.nqv", "md", "2").unwrap();
        db.trash("a.nqv").unwrap();
        assert_eq!(db.empty_trash(), 1);
        assert!(db.get("b.nqv").is_some() && db.list_trash().is_empty() && db.entries.len() == 1);
    }

    #[test]
    fn expired_trash_is_purged_after_30_days() {
        let mut db = Db::new();
        db.put("old.nqv", "md", "1").unwrap();
        db.put("recent.nqv", "md", "2").unwrap();
        db.put("live.nqv", "md", "3").unwrap();
        let now = 100 * 24 * 60 * 60 * 1000u64;
        db.trash_at("old.nqv", now - TRASH_KEEP_MS - 1).unwrap();
        db.trash_at("recent.nqv", now - TRASH_KEEP_MS + 1000).unwrap();
        assert_eq!(db.purge_expired(now), 1);
        assert_eq!(rels(db.list_trash()), vec!["recent.nqv"]);
        assert!(db.get("live.nqv").is_some());
    }

    #[test]
    fn tags_are_normalised_and_limited() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "").unwrap();
        let long = "x".repeat(50);
        db.set_tags("a.nqv", vec!["  #Work ".into(), "work".into(), "##".into(), "".into(), "bad\u{7}tag".into(), long]).unwrap();
        let t = &db.get("a.nqv").unwrap().tags;
        assert_eq!(t, &vec!["work".to_string(), "badtag".to_string(), "x".repeat(32)]);
        db.set_tags("a.nqv", (0..40).map(|i| format!("t{i}")).collect()).unwrap();
        assert_eq!(db.get("a.nqv").unwrap().tags.len(), 20);
        assert!(db.set_tags("missing.nqv", vec![]).is_err());
        db.mkdir("D").unwrap();
        db.set_tags("D", vec!["#f".into()]).unwrap();
        assert_eq!(db.list().iter().find(|i| i.rel == "D").unwrap().tags, vec!["f"]);
    }

    #[test]
    fn starring_and_put_keeps_tags_and_star() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "1").unwrap();
        db.set_starred("a.nqv", true).unwrap();
        db.set_tags("a.nqv", vec!["x".into()]).unwrap();
        db.put("a.nqv", "md", "2").unwrap();
        let e = db.get("a.nqv").unwrap();
        assert!(e.starred && e.tags == vec!["x"] && e.content == "2");
        let li = db.list();
        assert!(li[0].starred && li[0].tags == vec!["x"] && li[0].trashed_at.is_none());
        db.set_starred("a.nqv", false).unwrap();
        assert!(!db.get("a.nqv").unwrap().starred);
    }

    #[test]
    fn duplicate_names_and_copies_tags() {
        let mut db = Db::new();
        db.put("F/a.nqv", "md", "body").unwrap();
        db.set_tags("F/a.nqv", vec!["t".into()]).unwrap();
        db.set_starred("F/a.nqv", true).unwrap();
        assert_eq!(db.duplicate("F/a.nqv").unwrap(), "F/a (copy).nqv");
        assert_eq!(db.duplicate("F/a.nqv").unwrap(), "F/a (copy 2).nqv");
        assert_eq!(db.duplicate("F/a (copy).nqv").unwrap(), "F/a (copy) (copy).nqv");
        let c = db.get("F/a (copy 2).nqv").unwrap();
        assert!(c.content == "body" && c.ext == "md" && c.tags == vec!["t"] && !c.starred);
        assert!(db.duplicate("F").is_err());
    }

    #[test]
    fn old_json_without_new_fields_loads_and_sealed_round_trip_keeps_them() {
        let old = r#"{"v":1,"entries":{"i1":{"id":"i1","path":"a.nqv","ext":"md","content":"x","updated":5},
            "i2":{"id":"i2","path":"gone.nqv","updated":6,"deleted":true}}}"#;
        let db: Db = serde_json::from_str(old).unwrap();
        let e = &db.entries["i1"];
        assert!(e.tags.is_empty() && !e.starred && e.trashed_at.is_none());

        let (k, id) = keys();
        let mut db = Db::new();
        db.put("a.nqv", "md", "x").unwrap();
        db.put("b.nqv", "md", "y").unwrap();
        db.set_tags("a.nqv", vec!["t".into()]).unwrap();
        db.set_starred("a.nqv", true).unwrap();
        db.trash_at("b.nqv", 1234).unwrap();
        let back = Db::open(&k, &id, &db.seal(&k, &id).unwrap()).unwrap().unwrap();
        let a = back.get("a.nqv").unwrap();
        assert!(a.starred && a.tags == vec!["t"]);
        assert_eq!(back.list_trash()[0].trashed_at, Some(1234));
    }

    #[test]
    fn load_drops_tombstones() {
        let (k, id) = keys();
        let dir = std::env::temp_dir().join(format!("nqdb-ts-{}", new_id()));
        fs::create_dir_all(&dir).unwrap();
        let mut db = Db::new();
        db.put("a.nqv", "md", "x").unwrap();
        db.put("b.nqv", "md", "y").unwrap();
        db.delete("b.nqv").unwrap();
        save(&dir, &db.seal(&k, &id).unwrap()).unwrap();
        assert_eq!(load(&dir, &k, &id).unwrap().entries.len(), 1);
        fs::remove_dir_all(&dir).ok();
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
