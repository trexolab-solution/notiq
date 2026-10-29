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
use zeroize::{Zeroize, Zeroizing};

use crate::vault_core::{self as vc, VaultKey, VAULT_ID_LEN};

pub const DB_FILE: &str = "vault.nqdb";
/// `ext` stored (authenticated) in the sealed header, to tell a DB from a legacy manifest.
pub const DB_EXT: &str = "db";
const BAK_PREFIX: &str = "vault.nqdb.bak";
const BAK_KEEP: usize = 3;
const BAK_EVERY_SECS: u64 = 10 * 60;
/// One-time copy of a format-1 database, made before the first save that upgrades it.
const V1_BAK: &str = "vault.nqdb.v1.bak";
const NQV: &str = ".nqv";

/// Current on-disk format. 1 = 0.6.0 (notes, folders, tags, stars, trash);
/// 2 = 0.7.0 (+ per-entry revision history and attachments).
pub const DB_VERSION: u32 = 2;
/// Revisions kept per note (newest first).
pub const MAX_HISTORY: usize = 10;
pub const MAX_ATTACH_BYTES: u64 = 5 * 1024 * 1024;
pub const MAX_ATTACH_TOTAL: u64 = 25 * 1024 * 1024;
pub const MAX_ATTACH_PER_ENTRY: usize = 20;
pub const MAX_ATTACH_NAME: usize = 120;

/// An earlier version of a note's content.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Revision {
    /// Unix ms when this version was last saved.
    pub updated: u64,
    #[serde(default)]
    pub ext: String,
    #[serde(default)]
    pub content: String,
}

impl Drop for Revision {
    fn drop(&mut self) {
        self.content.zeroize();
    }
}

/// A file attached to a note, stored inside the encrypted database.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Attachment {
    /// 32 hex chars.
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub mime: String,
    /// Decoded size in bytes.
    pub size: u64,
    /// Unix ms when it was attached.
    #[serde(default)]
    pub added: u64,
    /// Standard base64 (with padding) of the file's bytes.
    #[serde(default)]
    pub data: String,
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.data.zeroize();
    }
}

/// What lists show for an attachment (never the data).
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct AttachmentMeta {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub added: u64,
}

impl Attachment {
    pub fn meta(&self) -> AttachmentMeta {
        AttachmentMeta { id: self.id.clone(), name: self.name.clone(), mime: self.mime.clone(), size: self.size, added: self.added }
    }
}

/// What lists show for a revision (never the content).
#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct RevisionMeta {
    /// 0 = newest.
    pub index: u32,
    pub updated: u64,
    pub ext: String,
    /// Content length in bytes (UTF-8).
    pub size: u64,
}

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
    /// Earlier contents, newest first, at most [`MAX_HISTORY`]. Never set on folders.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<Revision>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
}

/// Dropping an entry (purge, empty trash, lock) wipes its content; revisions and
/// attachments wipe themselves.
impl Drop for Entry {
    fn drop(&mut self) {
        self.content.zeroize();
    }
}

impl Entry {
    fn blank(id: String, path: &str, dir: bool, updated: u64) -> Entry {
        Entry {
            id, path: path.into(), ext: String::new(), content: String::new(), updated, deleted: false, dir,
            tags: vec![], starred: false, trashed_at: None, history: vec![], attachments: vec![],
        }
    }

    /// A live (not tombstoned, not trashed) entry.
    pub fn is_live(&self) -> bool {
        !self.deleted && self.trashed_at.is_none()
    }

    /// Saves the current (ext, content) as the newest revision before it is replaced.
    /// Folders and empty content are not recorded; a repeat of the newest revision is skipped.
    fn push_revision(&mut self) {
        if self.dir || self.content.is_empty() { return; }
        if self.history.first().is_some_and(|r| r.ext == self.ext && r.content == self.content) { return; }
        self.history.insert(0, Revision { updated: self.updated, ext: self.ext.clone(), content: self.content.clone() });
        self.history.truncate(MAX_HISTORY); // dropped revisions zeroise themselves
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
    /// Format version the data was loaded from (not stored). Below [`DB_VERSION`], the
    /// first save keeps a one-time copy of the old file (see [`save_db`]).
    #[serde(skip)]
    pub loaded_v: u32,
}
// Zeroising on drop happens per entry (see `Drop for Entry`).

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct ListItem {
    pub rel: String,
    pub ext: String,
    pub updated: u64,
    pub dir: bool,
    pub tags: Vec<String>,
    pub starred: bool,
    pub trashed_at: Option<u64>,
    /// Number of attachments (data is never listed).
    pub attachments: u32,
    /// Number of stored revisions.
    pub history: u32,
}

fn item(e: &Entry) -> ListItem {
    ListItem {
        rel: e.path.clone(), ext: e.ext.clone(), updated: e.updated, dir: e.dir,
        tags: e.tags.clone(), starred: e.starred, trashed_at: e.trashed_at,
        attachments: e.attachments.len() as u32, history: e.history.len() as u32,
    }
}

fn blank_dir(rel: &str, t: u64, trashed_at: Option<u64>) -> ListItem {
    ListItem { rel: rel.into(), ext: String::new(), updated: t, dir: true, tags: vec![], starred: false, trashed_at, attachments: 0, history: 0 }
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
        Db { v: DB_VERSION, loaded_v: DB_VERSION, ..Db::default() }
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
        let e = self.entries.entry(id.clone()).or_insert_with(|| Entry::blank(id, rel, false, 0));
        if e.ext != ext || e.content != content {
            e.push_revision();
            e.ext = ext.into();
            e.content.zeroize();
            e.content = content.into();
        }
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
        self.entries.insert(id.clone(), Entry::blank(id, rel, true, now_ms()));
        Ok(())
    }

    /// Delete a note, or a folder with everything in it. Only tests use this now; the app trashes (see `trash`).
    #[cfg(test)]
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
        for e in self.entries.values().filter(|e| e.is_live()) {
            for d in parent_dirs(&e.path) { dirs.entry(d.clone()).or_insert_with(|| blank_dir(&d, 0, None)); }
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
            out.insert((d.clone(), true), blank_dir(&d, t, Some(t)));
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
            self.entries.remove(id); // Drop zeroises content, history and attachments
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
    /// The copy starts without history or attachments.
    pub fn duplicate(&mut self, rel: &str) -> Result<String, String> {
        let src = self.get(rel).ok_or("Only notes can be duplicated")?;
        let (ext, content, tags) = (src.ext.clone(), Zeroizing::new(src.content.clone()), src.tags.clone());
        let to = (1u64..).map(|n| variant_path(rel, "copy", n, true)).find(|c| !self.occupied(c)).expect("unbounded");
        self.put(&to, &ext, &content)?;
        self.set_tags(&to, tags)?;
        Ok(to)
    }

    fn live_file(&self, rel: &str) -> Result<&Entry, String> {
        self.get(rel).ok_or_else(|| "This note no longer exists in the vault".to_string())
    }

    fn live_file_mut(&mut self, rel: &str) -> Result<&mut Entry, String> {
        let id = self.live_id(rel, false).ok_or("This note no longer exists in the vault")?.to_string();
        Ok(self.entries.get_mut(&id).expect("live id"))
    }

    // ─── history ─────────────────────────────────────────────────────────────

    pub fn history_list(&self, rel: &str) -> Result<Vec<RevisionMeta>, String> {
        Ok(self.live_file(rel)?.history.iter().enumerate().map(|(i, r)| RevisionMeta {
            index: i as u32, updated: r.updated, ext: r.ext.clone(), size: r.content.len() as u64,
        }).collect())
    }

    pub fn history_get(&self, rel: &str, index: usize) -> Result<&Revision, String> {
        self.live_file(rel)?.history.get(index).ok_or_else(|| "That version no longer exists".to_string())
    }

    /// Brings back revision `index`; the current content becomes the newest revision.
    pub fn history_restore(&mut self, rel: &str, index: usize) -> Result<(), String> {
        let r = self.history_get(rel, index)?;
        let (ext, content) = (r.ext.clone(), Zeroizing::new(r.content.clone()));
        self.put(rel, &ext, &content)
    }

    // ─── attachments ─────────────────────────────────────────────────────────

    /// Bytes of attachment data held by the whole vault (recycle bin included).
    pub fn attachments_total(&self) -> u64 {
        self.entries.values().flat_map(|e| e.attachments.iter()).map(|a| a.size).sum()
    }

    pub fn attach_add(&mut self, rel: &str, name: &str, data_b64: &str) -> Result<AttachmentMeta, String> {
        let name = sanitize_attachment_name(name)?;
        if self.live_file(rel)?.attachments.len() >= MAX_ATTACH_PER_ENTRY {
            return Err(format!("A note can have at most {MAX_ATTACH_PER_ENTRY} attachments"));
        }
        let too_big = || format!("Attachments can be at most {} MB each", MAX_ATTACH_BYTES / (1024 * 1024));
        // Refuse oversized input before decoding it.
        if data_b64.len() as u64 > MAX_ATTACH_BYTES.div_ceil(3) * 4 + 4 { return Err(too_big()); }
        let bytes = b64_decode(data_b64).ok_or("The attachment data isn't valid base64")?;
        let size = bytes.len() as u64;
        if size > MAX_ATTACH_BYTES { return Err(too_big()); }
        let used = self.attachments_total();
        if used + size > MAX_ATTACH_TOTAL {
            return Err(format!(
                "The vault can hold at most {} MB of attachments ({:.1} MB already used)",
                MAX_ATTACH_TOTAL / (1024 * 1024), used as f64 / (1024.0 * 1024.0)
            ));
        }
        let now = now_ms();
        let a = Attachment { id: new_id(), mime: guess_mime(&name).into(), name, size, added: now, data: b64_encode(&bytes) };
        let meta = a.meta();
        let e = self.live_file_mut(rel)?;
        e.attachments.push(a);
        e.updated = now;
        Ok(meta)
    }

    pub fn attach_list(&self, rel: &str) -> Result<Vec<AttachmentMeta>, String> {
        Ok(self.live_file(rel)?.attachments.iter().map(Attachment::meta).collect())
    }

    pub fn attach_get(&self, rel: &str, id: &str) -> Result<&Attachment, String> {
        self.live_file(rel)?.attachments.iter().find(|a| a.id == id).ok_or_else(|| "That attachment no longer exists".to_string())
    }

    pub fn attach_remove(&mut self, rel: &str, id: &str) -> Result<(), String> {
        let e = self.live_file_mut(rel)?;
        let i = e.attachments.iter().position(|a| a.id == id).ok_or("That attachment no longer exists")?;
        e.attachments.remove(i); // zeroised on drop
        e.updated = now_ms();
        Ok(())
    }
}

// ─── attachment helpers ──────────────────────────────────────────────────────

/// Keeps only the last path component, drops control chars, replaces characters that
/// aren't allowed in file names, trims, and caps the length (keeping a short extension).
pub fn sanitize_attachment_name(name: &str) -> Result<String, String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() { return Err("The attachment needs a file name".into()); }
    if cleaned.chars().count() <= MAX_ATTACH_NAME { return Ok(cleaned); }
    let ext = cleaned.rfind('.').filter(|&i| i > 0).map(|i| &cleaned[i..]).filter(|x| x.chars().count() <= 17).unwrap_or("");
    let stem: String = cleaned[..cleaned.len() - ext.len()].chars().take(MAX_ATTACH_NAME - ext.chars().count()).collect();
    Ok(format!("{}{ext}", stem.trim_end()))
}

/// MIME type from the file extension; `application/octet-stream` when unknown.
pub fn guess_mime(name: &str) -> &'static str {
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "xml" => "application/xml",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "pem" | "crt" | "cer" | "key" => "application/x-pem-file",
        _ => "application/octet-stream",
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn b64_encode(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for ch in b.chunks(3) {
        let n = (ch[0] as u32) << 16 | (*ch.get(1).unwrap_or(&0) as u32) << 8 | *ch.get(2).unwrap_or(&0) as u32;
        s.push(B64[(n >> 18 & 63) as usize] as char);
        s.push(B64[(n >> 12 & 63) as usize] as char);
        s.push(if ch.len() > 1 { B64[(n >> 6 & 63) as usize] as char } else { '=' });
        s.push(if ch.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    s
}

/// Standard base64; padding optional, no whitespace. `None` when malformed.
pub fn b64_decode(s: &str) -> Option<Zeroizing<Vec<u8>>> {
    let body = s.trim_end_matches('=');
    let pad = s.len() - body.len();
    if pad > 2 || (pad > 0 && s.len() % 4 != 0) || body.len() % 4 == 1 { return None; }
    let mut out = Zeroizing::new(Vec::with_capacity(body.len() * 3 / 4));
    let (mut acc, mut bits) = (0u32, 0u32);
    for &c in body.as_bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
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
        let mut db: Db = serde_json::from_slice(&plain).map_err(|_| "The vault database is corrupted".to_string())?;
        // Older formats load through serde defaults; the next save writes the current one.
        db.loaded_v = db.v;
        db.v = DB_VERSION;
        Ok(Some(db))
    }
}

// ─── on disk ─────────────────────────────────────────────────────────────────

pub fn db_path(root: &Path) -> PathBuf {
    root.join(DB_FILE)
}

pub fn v1_bak_path(root: &Path) -> PathBuf {
    root.join(V1_BAK)
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

/// Seals `db` and writes it (see [`save`]). The first save of a database loaded from an
/// older format first copies the existing file to `vault.nqdb.v1.bak` (never overwriting
/// one that is already there), so the upgrade can always be undone by hand.
pub fn save_db(root: &Path, db: &mut Db, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN]) -> Result<(), String> {
    let bytes = db.seal(key, vault_id)?;
    if db.loaded_v < DB_VERSION {
        let (main, bak) = (db_path(root), v1_bak_path(root));
        if main.exists() && !bak.exists() {
            fs::copy(&main, &bak).map_err(|e| format!("Couldn't back up the old vault database before upgrading it: {e}"))?;
        }
    }
    save(root, &bytes)?;
    db.loaded_v = DB_VERSION;
    Ok(())
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

    // ─── 0.7.0: format v2 (history + attachments) ────────────────────────────

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nqdb-{tag}-{}", new_id()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A 0.6.0 database exactly as that version wrote it.
    const V1_FIXTURE: &str = r#"{"v":1,"entries":{
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa":{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","path":"Work/plan.nqv","ext":"md","content":"the plan","updated":1700000000000,"deleted":false,"dir":false,"tags":["work"],"starred":true,"trashed_at":null},
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb":{"id":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","path":"Work","ext":"","content":"","updated":1700000000000,"deleted":false,"dir":true,"tags":[],"starred":false,"trashed_at":null},
        "cccccccccccccccccccccccccccccccc":{"id":"cccccccccccccccccccccccccccccccc","path":"old.nqv","ext":"login","content":"{}","updated":1700000000001,"deleted":false,"dir":false,"tags":[],"starred":false,"trashed_at":4102444800000}
    },"legacy_imported":true}"#;

    #[test]
    fn v1_file_loads_and_first_upgrading_save_keeps_a_one_time_backup() {
        let (k, id) = keys();
        let dir = tmpdir("mig");
        let v1 = vc::seal(&k, &id, DB_EXT, V1_FIXTURE.as_bytes()).unwrap();
        fs::write(db_path(&dir), &v1).unwrap();

        let mut db = load(&dir, &k, &id).unwrap();
        assert_eq!((db.loaded_v, db.v), (1, DB_VERSION));
        let e = db.get("Work/plan.nqv").unwrap();
        assert!(e.content == "the plan" && e.tags == vec!["work"] && e.starred && e.history.is_empty() && e.attachments.is_empty());
        assert!(db.legacy_imported);
        assert_eq!(db.list_trash()[0].rel, "old.nqv");
        let li = db.list();
        assert!(li.iter().all(|i| i.attachments == 0 && i.history == 0));
        assert!(!v1_bak_path(&dir).exists(), "loading alone writes nothing");

        db.put("Work/plan.nqv", "md", "the new plan").unwrap();
        save_db(&dir, &mut db, &k, &id).unwrap();
        assert_eq!(fs::read(v1_bak_path(&dir)).unwrap(), v1, "backup is the untouched v1 file");
        assert_eq!(db.loaded_v, DB_VERSION);

        let back = load(&dir, &k, &id).unwrap();
        assert_eq!(back.loaded_v, DB_VERSION);
        let e = back.get("Work/plan.nqv").unwrap();
        assert_eq!(e.content, "the new plan");
        assert_eq!(e.history[0].content, "the plan");

        // An existing .v1.bak is never overwritten, even by another upgrade.
        fs::write(v1_bak_path(&dir), b"keep me").unwrap();
        let mut db: Db = serde_json::from_str(V1_FIXTURE).unwrap();
        db.loaded_v = 1;
        save_db(&dir, &mut db, &k, &id).unwrap();
        assert_eq!(fs::read(v1_bak_path(&dir)).unwrap(), b"keep me");
        // A v2 database never makes one.
        let dir2 = tmpdir("mig2");
        let mut db = Db::new();
        db.put("a.nqv", "md", "x").unwrap();
        save_db(&dir2, &mut db, &k, &id).unwrap();
        save_db(&dir2, &mut db, &k, &id).unwrap();
        assert!(!v1_bak_path(&dir2).exists());
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&dir2).ok();
    }

    #[test]
    fn v2_round_trips_and_unknown_future_fields_are_ignored() {
        let (k, id) = keys();
        let mut db = Db::new();
        db.put("a.nqv", "md", "1").unwrap();
        db.put("a.nqv", "md", "2").unwrap();
        let m = db.attach_add("a.nqv", "k.pem", &b64_encode(b"-----KEY-----")).unwrap();
        let back = Db::open(&k, &id, &db.seal(&k, &id).unwrap()).unwrap().unwrap();
        let e = back.get("a.nqv").unwrap();
        assert_eq!(e.history, db.get("a.nqv").unwrap().history);
        assert_eq!(e.attachments, db.get("a.nqv").unwrap().attachments);
        assert_eq!(back.attach_list("a.nqv").unwrap(), vec![m]);

        let future = r#"{"v":3,"newTopLevel":{"x":1},"entries":{"i1":{"id":"i1","path":"a.nqv","ext":"md","content":"x","updated":5,
            "colour":"red","history":[{"updated":1,"ext":"md","content":"o","author":"me"}],
            "attachments":[{"id":"0123456789abcdef0123456789abcdef","name":"f.txt","mime":"text/plain","size":2,"added":3,"data":"aGk=","sha":"zz"}]}}}"#;
        let sealed = vc::seal(&k, &id, DB_EXT, future.as_bytes()).unwrap();
        let db = Db::open(&k, &id, &sealed).unwrap().unwrap();
        let e = db.get("a.nqv").unwrap();
        assert_eq!(e.history[0].content, "o");
        assert_eq!(b64_decode(&db.attach_get("a.nqv", "0123456789abcdef0123456789abcdef").unwrap().data).unwrap().as_slice(), b"hi");
    }

    #[test]
    fn history_records_changes_dedupes_and_caps() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "").unwrap();
        db.put("a.nqv", "md", "v0").unwrap();
        assert!(db.get("a.nqv").unwrap().history.is_empty(), "empty content isn't a revision");
        db.put("a.nqv", "md", "v0").unwrap();
        assert!(db.get("a.nqv").unwrap().history.is_empty(), "unchanged save isn't a revision");
        db.put("a.nqv", "txt", "v0").unwrap();
        assert_eq!(db.history_list("a.nqv").unwrap().len(), 1, "an ext change is a revision");
        for i in 1..=15 { db.put("a.nqv", "md", &format!("v{i}")).unwrap(); }
        let h = db.history_list("a.nqv").unwrap();
        assert_eq!(h.len(), MAX_HISTORY);
        assert_eq!(db.history_get("a.nqv", 0).unwrap().content, "v14", "newest first");
        assert_eq!(db.history_get("a.nqv", 9).unwrap().content, "v5", "oldest dropped");
        assert_eq!((h[0].index, h[0].size, h[0].ext.as_str()), (0, 3, "md"));
        assert!(db.history_get("a.nqv", 10).is_err());
        assert_eq!(db.list()[0].history, 10);

        // dedupe against the newest revision: a -> b -> a -> b keeps alternating, but
        // re-saving the same previous content twice in a row is skipped
        let mut db = Db::new();
        db.put("b.nqv", "md", "x").unwrap();
        db.put("b.nqv", "md", "y").unwrap();
        db.entries.values_mut().next().unwrap().content = "x".into(); // newest revision == current
        db.put("b.nqv", "md", "z").unwrap();
        assert_eq!(db.get("b.nqv").unwrap().history.len(), 1);

        // folders never get history
        db.mkdir("D").unwrap();
        assert!(db.entries.values().filter(|e| e.dir).all(|e| e.history.is_empty()));
    }

    #[test]
    fn history_restore_makes_current_a_revision() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "one").unwrap();
        db.put("a.nqv", "md", "two").unwrap();
        db.put("a.nqv", "md", "three").unwrap();
        db.history_restore("a.nqv", 1).unwrap(); // "one"
        let e = db.get("a.nqv").unwrap();
        assert_eq!(e.content, "one");
        assert_eq!(e.history.iter().map(|r| r.content.as_str()).collect::<Vec<_>>(), vec!["three", "two", "one"]);
        assert!(db.history_restore("a.nqv", 99).is_err() && db.history_restore("x.nqv", 0).is_err());
    }

    #[test]
    fn trash_keeps_history_and_attachments_duplicate_copies_neither() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "1").unwrap();
        db.put("a.nqv", "md", "2").unwrap();
        db.attach_add("a.nqv", "f.txt", &b64_encode(b"hi")).unwrap();
        let d = db.duplicate("a.nqv").unwrap();
        let c = db.get(&d).unwrap();
        assert!(c.history.is_empty() && c.attachments.is_empty() && c.content == "2");
        db.trash("a.nqv").unwrap();
        let t = db.list_trash();
        assert_eq!((t[0].history, t[0].attachments), (1, 1));
        assert!(db.history_list("a.nqv").is_err(), "trashed notes aren't reachable by path");
        db.restore("a.nqv").unwrap();
        assert_eq!(db.history_list("a.nqv").unwrap().len(), 1);
        assert_eq!(db.attach_list("a.nqv").unwrap().len(), 1);
    }

    #[test]
    fn purge_empty_trash_and_expiry_remove_history_and_attachments() {
        let mut db = Db::new();
        for n in ["a", "b", "c"] {
            let rel = format!("{n}.nqv");
            db.put(&rel, "md", "1").unwrap();
            db.put(&rel, "md", "2").unwrap();
            db.attach_add(&rel, "f.bin", &b64_encode(&[7u8; 1000])).unwrap();
        }
        assert_eq!(db.attachments_total(), 3000);
        db.trash("a.nqv").unwrap();
        db.purge("a.nqv").unwrap();
        db.trash_at("b.nqv", 1).unwrap();
        db.purge_expired(TRASH_KEEP_MS + 10);
        db.trash("c.nqv").unwrap();
        db.empty_trash();
        assert!(db.entries.is_empty());
        assert_eq!(db.attachments_total(), 0);
    }

    #[test]
    fn attachment_add_list_get_remove_and_limits() {
        let mut db = Db::new();
        db.put("a.nqv", "md", "x").unwrap();
        let m = db.attach_add("a.nqv", "C:\\Users\\me\\Photo.PNG", &b64_encode(b"\x89PNG")).unwrap();
        assert_eq!((m.name.as_str(), m.mime.as_str(), m.size), ("Photo.PNG", "image/png", 4));
        assert_eq!(m.id.len(), 32);
        assert!(m.id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(db.attach_add("a.nqv", "blob", "AA==").unwrap().mime, "application/octet-stream");
        assert_eq!(db.attach_list("a.nqv").unwrap().len(), 2);
        assert_eq!(db.list()[0].attachments, 2);
        let listed = serde_json::to_string(&db.list()).unwrap() + &serde_json::to_string(&db.attach_list("a.nqv").unwrap()).unwrap();
        assert!(!listed.contains("iVBO") && !listed.contains("\"data\""), "lists never carry data");
        assert_eq!(b64_decode(&db.attach_get("a.nqv", &m.id).unwrap().data).unwrap().as_slice(), b"\x89PNG");
        db.attach_remove("a.nqv", &m.id).unwrap();
        assert!(db.attach_get("a.nqv", &m.id).is_err() && db.attach_remove("a.nqv", &m.id).is_err());

        // errors
        assert!(db.attach_add("a.nqv", "x.txt", "not base64!").unwrap_err().contains("base64"));
        assert!(db.attach_add("a.nqv", " / ", "AA==").is_err());
        assert!(db.attach_add("missing.nqv", "x", "AA==").is_err());
        db.mkdir("D").unwrap();
        assert!(db.attach_add("D", "x", "AA==").is_err(), "folders can't hold attachments");
        let big = b64_encode(&vec![0u8; MAX_ATTACH_BYTES as usize + 1]);
        assert!(db.attach_add("a.nqv", "big", &big).unwrap_err().contains("5 MB"));
        assert!(db.attach_add("a.nqv", "big", &(big + "AAAA")).unwrap_err().contains("5 MB"));

        // per-entry count
        for i in 0..(MAX_ATTACH_PER_ENTRY - 1) { db.attach_add("a.nqv", &format!("{i}"), "AA==").unwrap(); }
        assert!(db.attach_add("a.nqv", "one-more", "AA==").unwrap_err().contains("20"));

        // vault-wide total
        let mut db = Db::new();
        let four = b64_encode(&vec![1u8; 4 * 1024 * 1024]);
        for i in 0..6 {
            let rel = format!("n{i}.nqv");
            db.put(&rel, "md", "x").unwrap();
            db.attach_add(&rel, "f", &four).unwrap();
        }
        db.put("last.nqv", "md", "x").unwrap();
        assert!(db.attach_add("last.nqv", "f", &four).unwrap_err().contains("25 MB"));
        db.attach_add("last.nqv", "f", &b64_encode(&vec![1u8; 1024 * 1024])).unwrap(); // exactly 25 MB
        assert_eq!(db.attachments_total(), MAX_ATTACH_TOTAL);
    }

    #[test]
    fn attachment_names_are_sanitised() {
        assert_eq!(sanitize_attachment_name("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(sanitize_attachment_name("a\u{0}b\nc:d?.txt. ").unwrap(), "abc_d_.txt");
        assert_eq!(sanitize_attachment_name(".env").unwrap(), ".env");
        assert!(sanitize_attachment_name("..").is_err() && sanitize_attachment_name("dir/").is_err());
        let long = format!("{}.tar.gz", "n".repeat(300));
        let s = sanitize_attachment_name(&long).unwrap();
        assert_eq!(s.chars().count(), MAX_ATTACH_NAME);
        assert!(s.ends_with(".gz") && s.starts_with("nnn"));
        assert_eq!(sanitize_attachment_name(&"é".repeat(200)).unwrap().chars().count(), MAX_ATTACH_NAME);
    }

    #[test]
    fn base64_matches_the_standard_vectors() {
        for (raw, enc) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")] {
            assert_eq!(b64_encode(raw.as_bytes()), enc);
            assert_eq!(b64_decode(enc).unwrap().as_slice(), raw.as_bytes());
        }
        assert_eq!(b64_decode("Zm8").unwrap().as_slice(), b"fo", "padding optional");
        assert!(b64_decode("Zm9vY").is_none() && b64_decode("Zg===").is_none() && b64_decode("Zm8=Zm8=").is_none() && b64_decode("Zm 9v").is_none());
        let all: Vec<u8> = (0..=255u8).collect();
        assert_eq!(b64_decode(&b64_encode(&all)).unwrap().as_slice(), all.as_slice());
    }

    #[test]
    fn four_mb_attachment_round_trips_through_seal_and_disk() {
        let (k, id) = keys();
        let dir = tmpdir("big");
        let data: Vec<u8> = (0..4 * 1024 * 1024u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        let mut db = Db::new();
        db.put("a.nqv", "md", "x").unwrap();
        let m = db.attach_add("a.nqv", "blob.bin", &b64_encode(&data)).unwrap();
        save_db(&dir, &mut db, &k, &id).unwrap();
        // a second save rotates nothing new within 10 minutes but must still succeed
        save_db(&dir, &mut db, &k, &id).unwrap();
        let back = load(&dir, &k, &id).unwrap();
        let a = back.attach_get("a.nqv", &m.id).unwrap();
        assert_eq!(a.size, data.len() as u64);
        assert_eq!(b64_decode(&a.data).unwrap().as_slice(), data.as_slice());
        assert!(bak_path(&dir, 1).exists(), ".bak.1 rotation still happens");
        fs::remove_dir_all(&dir).ok();
    }
}
