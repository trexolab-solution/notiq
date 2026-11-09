//! Local-only "changed by sync" markers: which entries a sync merge brought in from the store
//! (added, updated, restored, removed), from which device and when, and which version the merge
//! replaced, so the vault can show a dot on them and a before/after comparison.
//!
//! Markers never leave this device: they live in `<vault root>/vault.nqsm`, sealed with the vault
//! key (like `vault.nqdb`; nothing about the entries is readable on disk), not in the database the
//! snapshots and the merge are made of. At most [`MAX_MARKERS`] (newest first). A marker goes
//! when the user opens its entry, or with "Mark all as seen".
//!
//! The version a sync replaced normally stays in the entry's history (the merge keeps it as
//! history or as a conflict revision, under its stamp: [`Marker::before`]). Only when the merged
//! history no longer holds it (the cap dropped it) does the marker keep its own sealed copy.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use zeroize::Zeroize;

use crate::vault::VaultState;
use crate::vault_core::{self as vc, VaultKey, VAULT_ID_LEN};
use crate::vault_db::{Db, Entry};
use crate::vault_hlc::Hlc;
use crate::vault_merge::{ChangeKind, EntryChange};

pub const MARKERS_FILE: &str = "vault.nqsm";
const MARKERS_EXT: &str = "sm";
pub const MAX_MARKERS: usize = 500;
/// Emitted (`{}`) whenever the markers change.
pub const MARKERS_EVENT: &str = "vault-sync://markers";

/// Serialises load-modify-save of the markers file.
static FILE_LOCK: Mutex<()> = Mutex::new(());

/// A sealed copy of the version a sync replaced (only when history no longer has it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Kept {
    pub ext: String,
    pub content: String,
}

impl Drop for Kept {
    fn drop(&mut self) {
        self.content.zeroize();
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    /// Entry id.
    pub id: String,
    pub kind: ChangeKind,
    /// Device NAME the change came from (empty when unknown; never an id once stored).
    pub from_device: String,
    /// Unix ms of the sync.
    pub at: u64,
    /// Stamp of the local version the sync replaced (see the module docs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Hlc>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_copy: Option<Kept>,
}

#[derive(Serialize, Deserialize, Default)]
struct File {
    v: u32,
    markers: Vec<Marker>,
}

/// What the UI lists: a marker plus where its entry is now (never stored).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarkerView {
    pub id: String,
    pub kind: ChangeKind,
    pub from_device: String,
    pub at: u64,
    /// The entry's vault-relative path now.
    pub rel: String,
    pub dir: bool,
    /// In the recycle bin.
    pub trashed: bool,
    /// Permanently deleted (a tombstone: nothing to open).
    pub deleted: bool,
    /// A "before" version can be shown.
    pub has_before: bool,
    /// The history index holding the "before" version, when it is in history.
    pub before_index: Option<u32>,
}

// ─── building (from a merge) ────────────────────────────────────────────────

/// The local versions a merge with `remote` may replace (the content differs there), copied
/// before the merge so a version the merged history drops can still be compared with.
pub struct Prior(BTreeMap<String, (Hlc, Kept)>);

pub fn prior(local: &Db, remote: &Db) -> Prior {
    Prior(local.entries.iter()
        .filter(|(id, l)| !l.dir && !l.deleted && !l.content.is_empty() && remote.entries.get(*id).is_some_and(|r| r.stamp != l.stamp))
        .map(|(id, l)| (id.clone(), (l.stamp.clone(), Kept { ext: l.ext.clone(), content: l.content.clone() })))
        .collect())
}

/// Markers for `changes`, right after the merge into `merged` (`from_device` still holds the
/// device ID; [`name_devices`] turns it into a name). Keeps a copy (from `prior`) of a replaced
/// version the merged history no longer holds.
pub fn collect(prior: &Prior, merged: &Db, changes: &[EntryChange], now: u64) -> Vec<Marker> {
    changes.iter().map(|c| {
        let mut before = c.before.clone();
        let mut before_copy = None;
        if let (Some(s), Some(m)) = (&before, merged.entries.get(&c.id)) {
            if history_index(m, s).is_none() {
                before_copy = prior.0.get(&c.id).filter(|(ps, _)| ps == s).map(|(_, k)| k.clone());
                if before_copy.is_none() { before = None; }
            }
        }
        Marker { id: c.id.clone(), kind: c.kind, from_device: c.device.clone(), at: now, before, before_copy }
    }).collect()
}

/// Turns device ids into names (`name_of` returns `None` when unknown → empty, never the id).
pub fn name_devices(marks: &mut [Marker], name_of: impl Fn(&str) -> Option<String>) {
    for m in marks {
        m.from_device = name_of(&m.from_device).unwrap_or_default();
    }
}

/// Folds `new` into `cur`: one marker per entry. A marker the user hasn't seen yet keeps its
/// first "before" (the comparison then spans every sync since) and stays "added" while the entry
/// is still there; device, time and otherwise the kind come from the newer one. Newest first,
/// capped at [`MAX_MARKERS`].
pub fn fold(cur: &mut Vec<Marker>, new: Vec<Marker>) {
    for mut n in new {
        if let Some(o) = cur.iter_mut().find(|o| o.id == n.id) {
            if o.before.is_some() || o.kind == ChangeKind::Added {
                n.before = o.before.take();
                n.before_copy = o.before_copy.take();
            }
            if o.kind == ChangeKind::Added && n.kind == ChangeKind::Updated { n.kind = ChangeKind::Added; }
            *o = n;
        } else {
            cur.push(n);
        }
    }
    cur.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.id.cmp(&b.id)));
    cur.truncate(MAX_MARKERS);
}

fn history_index(e: &Entry, s: &Hlc) -> Option<usize> {
    e.history.iter().position(|r| r.stamp.as_ref() == Some(s))
}

/// Markers as the UI lists them (markers of entries that no longer exist are left out).
pub fn views(marks: &[Marker], db: &Db) -> Vec<MarkerView> {
    marks.iter().filter_map(|m| {
        let e = db.entries.get(&m.id)?;
        let before_index = m.before.as_ref().and_then(|s| history_index(e, s)).map(|i| i as u32);
        Some(MarkerView {
            id: m.id.clone(),
            kind: m.kind,
            from_device: m.from_device.clone(),
            at: m.at,
            rel: e.path.clone(),
            dir: e.dir,
            trashed: e.is_trashed(),
            deleted: e.deleted,
            has_before: !e.deleted && (before_index.is_some() || m.before_copy.is_some()),
            before_index,
        })
    }).collect()
}

/// The version marker `id`'s sync replaced: `(ext, content)`.
pub fn before_of(marks: &[Marker], db: &Db, id: &str) -> Option<(String, String)> {
    let m = marks.iter().find(|m| m.id == id)?;
    let e = db.entries.get(id).filter(|e| !e.deleted)?;
    if let Some(i) = m.before.as_ref().and_then(|s| history_index(e, s)) {
        let r = &e.history[i];
        return Some((r.ext.clone(), r.content.clone()));
    }
    m.before_copy.as_ref().map(|k| (k.ext.clone(), k.content.clone()))
}

// ─── on disk ─────────────────────────────────────────────────────────────────

pub fn markers_path(root: &Path) -> PathBuf {
    root.join(MARKERS_FILE)
}

/// The markers of this vault (empty when there is no file, or it belongs to another vault).
pub fn load(root: &Path, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN]) -> Vec<Marker> {
    let Ok(bytes) = std::fs::read(markers_path(root)) else { return vec![] };
    match vc::open(key, vault_id, &bytes) {
        Ok((ext, plain)) if ext == MARKERS_EXT => serde_json::from_slice::<File>(&plain).map(|f| f.markers).unwrap_or_default(),
        _ => vec![],
    }
}

pub fn save(root: &Path, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], marks: Vec<Marker>) -> Result<(), String> {
    let path = markers_path(root);
    if marks.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    let json = zeroize::Zeroizing::new(serde_json::to_vec(&File { v: 1, markers: marks }).map_err(|e| e.to_string())?);
    let sealed = vc::seal(key, vault_id, MARKERS_EXT, &json).map_err(|e| e.to_string())?;
    crate::vault::atomic_write(&path, &sealed)
}

/// Load, change, save (under the file lock). `f` returns whether it changed anything.
fn update(root: &Path, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], f: impl FnOnce(&mut Vec<Marker>) -> bool) -> Result<bool, String> {
    let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut marks = load(root, key, vault_id);
    if !f(&mut marks) { return Ok(false); }
    save(root, key, vault_id, marks)?;
    Ok(true)
}

pub fn record(root: &Path, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], new: Vec<Marker>) -> Result<bool, String> {
    if new.is_empty() { return Ok(false); }
    update(root, key, vault_id, |cur| { fold(cur, new); true })
}

/// Clears one entry's marker (`Some(id)`) or all of them.
pub fn clear(root: &Path, key: &VaultKey, vault_id: &[u8; VAULT_ID_LEN], id: Option<&str>) -> Result<bool, String> {
    update(root, key, vault_id, |cur| {
        let n = cur.len();
        match id { Some(id) => cur.retain(|m| m.id != id), None => cur.clear() }
        cur.len() != n
    })
}

// ─── app glue ────────────────────────────────────────────────────────────────

fn notify(app: &AppHandle) {
    let _ = app.emit(MARKERS_EVENT, serde_json::json!({}));
}

/// After a sync cycle: stores its markers (best effort; a failure only loses the dots).
pub(crate) fn record_after_sync(app: &AppHandle, marks: Vec<Marker>) {
    if marks.is_empty() { return; }
    let vault = app.state::<VaultState>();
    let (Some((key, vault_id)), Some(root)) = (vault.key_copy(), vault.root()) else { return };
    match record(&root, &key, &vault_id, marks) {
        Ok(true) => notify(app),
        Ok(false) => {}
        Err(e) => eprintln!("[sync] couldn't save the sync markers: {e}"),
    }
}

#[tauri::command]
pub fn sync_markers_list(state: State<'_, VaultState>) -> Result<Vec<MarkerView>, String> {
    state.with_db(|db, root, key, vid| {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        Ok((views(&load(root, key, vid), db), false))
    })
}

#[derive(Serialize)]
pub struct BeforeVersion {
    content: String,
    ext: String,
}

impl Drop for BeforeVersion {
    fn drop(&mut self) {
        self.content.zeroize();
    }
}

/// The version entry `id` had before the sync that marked it (`None`: nothing to compare with).
#[tauri::command]
pub fn sync_marker_before(state: State<'_, VaultState>, id: String) -> Result<Option<BeforeVersion>, String> {
    state.with_db(|db, root, key, vid| {
        let _g = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let v = before_of(&load(root, key, vid), db, &id).map(|(ext, content)| BeforeVersion { content, ext });
        Ok((v, false))
    })
}

fn clear_cmd(app: &AppHandle, id: Option<&str>) -> Result<(), String> {
    let vault = app.state::<VaultState>();
    let (key, vault_id) = vault.key_copy().ok_or(super::engine::ERR_LOCKED)?;
    let root = vault.root().ok_or("The vault folder isn't set yet")?;
    if clear(&root, &key, &vault_id, id)? { notify(app); }
    Ok(())
}

#[tauri::command]
pub fn sync_marker_clear(app: AppHandle, id: String) -> Result<(), String> {
    clear_cmd(&app, Some(&id))
}

#[tauri::command]
pub fn sync_markers_clear_all(app: AppHandle) -> Result<(), String> {
    clear_cmd(&app, None)
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_merge::merge_into;

    fn keys() -> (VaultKey, [u8; VAULT_ID_LEN]) {
        (zeroize::Zeroizing::new([7u8; vc::KEY_LEN]), [3u8; VAULT_ID_LEN])
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nqsm-{tag}-{}", crate::vault_hlc::new_device_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn mk(id: &str, kind: ChangeKind, at: u64) -> Marker {
        Marker { id: id.into(), kind, from_device: "LAPTOP".into(), at, before: None, before_copy: None }
    }

    fn dev(name: &str, wall: u64) -> Db {
        let mut d = Db::new();
        d.device = name.into();
        d.clock = Hlc { wall, counter: 0, device: name.into() };
        d
    }

    fn at(db: &mut Db, wall: u64) {
        if wall > db.clock.wall { db.clock = Hlc { wall, counter: 0, device: db.device.clone() }; }
    }

    const BASE: u64 = 5_000_000_000_000;

    #[test]
    fn markers_are_sealed_on_disk_and_round_trip() {
        let (k, id) = keys();
        let dir = tmpdir("seal");
        let mut m = mk("e1", ChangeKind::Updated, 10);
        m.before_copy = Some(Kept { ext: "md".into(), content: "Secret Bank Note".into() });
        assert!(record(&dir, &k, &id, vec![m.clone()]).unwrap());
        let raw = std::fs::read(markers_path(&dir)).unwrap();
        let text = String::from_utf8_lossy(&raw);
        for s in ["e1", "LAPTOP", "Secret Bank Note", "updated"] {
            assert!(!text.contains(s), "{s} readable on disk");
        }
        assert_eq!(load(&dir, &k, &id), vec![m]);
        // another vault (or key) can't read them: empty, not an error
        assert!(load(&dir, &k, &[9u8; VAULT_ID_LEN]).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn markers_are_capped_newest_first_and_cleared() {
        let (k, id) = keys();
        let dir = tmpdir("cap");
        let many: Vec<Marker> = (0..(MAX_MARKERS as u64 + 20)).map(|i| mk(&format!("e{i}"), ChangeKind::Added, i)).collect();
        record(&dir, &k, &id, many).unwrap();
        let got = load(&dir, &k, &id);
        assert_eq!(got.len(), MAX_MARKERS);
        assert_eq!(got[0].at, MAX_MARKERS as u64 + 19);
        assert!(got.iter().all(|m| m.at >= 20), "the oldest went");
        assert!(clear(&dir, &k, &id, Some("e100")).unwrap());
        assert!(!clear(&dir, &k, &id, Some("e100")).unwrap(), "already gone");
        assert_eq!(load(&dir, &k, &id).len(), MAX_MARKERS - 1);
        assert!(clear(&dir, &k, &id, None).unwrap());
        assert!(load(&dir, &k, &id).is_empty() && !markers_path(&dir).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fold_keeps_the_first_before_and_added_stays_added() {
        let mut cur = vec![];
        let mut a = mk("x", ChangeKind::Updated, 1);
        a.before = Some(Hlc { wall: 1, counter: 1, device: "B".into() });
        fold(&mut cur, vec![a.clone(), mk("n", ChangeKind::Added, 1)]);
        let mut b = mk("x", ChangeKind::Updated, 2);
        b.before = Some(Hlc { wall: 2, counter: 1, device: "B".into() });
        b.from_device = "DESKTOP".into();
        fold(&mut cur, vec![b, mk("n", ChangeKind::Updated, 2)]);
        let x = cur.iter().find(|m| m.id == "x").unwrap();
        assert_eq!((x.before.clone(), x.at, x.from_device.as_str()), (a.before, 2, "DESKTOP"));
        assert_eq!(cur.iter().find(|m| m.id == "n").unwrap().kind, ChangeKind::Added);
        assert_eq!(cur.len(), 2);
    }

    #[test]
    fn markers_are_not_part_of_the_database_or_its_snapshots() {
        let (k, id) = keys();
        let dir = tmpdir("local");
        let mut db = dev("A", BASE);
        db.put("n.nqv", "md", "x").unwrap();
        let eid = db.get("n.nqv").unwrap().id.clone();
        record(&dir, &k, &id, vec![mk(&eid, ChangeKind::Added, 1)]).unwrap();
        crate::vault_db::save_db(&dir, &mut db, &k, &id).unwrap();
        // the database (what snapshots are made of) knows nothing about markers
        let json = serde_json::to_string(&db).unwrap();
        assert!(!json.contains("marker") && !json.contains("LAPTOP"));
        let snap = crate::sync::seal::strip_attachment_data(&db);
        assert!(!serde_json::to_string(&snap).unwrap().contains("LAPTOP"));
        // and a different file from vault.nqdb
        assert_ne!(markers_path(&dir), crate::vault_db::db_path(&dir));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn collect_points_at_the_history_version_or_keeps_a_copy() {
        let mut base = dev("base", BASE);
        base.put("n.nqv", "md", "v0").unwrap();
        let mut a = base.clone();
        a.device = "A".into();
        let mut b = base.clone();
        b.device = "B".into();
        at(&mut a, BASE + 10);
        a.put("n.nqv", "md", "v1").unwrap();
        // in history: the marker points at it
        let mut lb = b.clone();
        let r = merge_into(&mut lb, &a);
        let mut marks = collect(&prior(&b, &a), &lb, &r.changes, 99);
        assert!(marks[0].before.is_some() && marks[0].before_copy.is_none());
        name_devices(&mut marks, |d| (d == "A").then(|| "LAPTOP".to_string()));
        assert_eq!(marks[0].from_device, "LAPTOP");
        let v = views(&marks, &lb);
        assert_eq!((v[0].rel.as_str(), v[0].has_before, v[0].before_index), ("n.nqv", true, Some(0)));
        assert_eq!(before_of(&marks, &lb, &marks[0].id), Some(("md".into(), "v0".into())));

        // many edits elsewhere: the remote history no longer holds v0, but the merge still keeps
        // this device's version (as a conflict revision), so it stays retrievable
        for i in 0..(crate::vault_db::MAX_HISTORY + 2) {
            at(&mut a, BASE + 20 + i as u64);
            a.put("n.nqv", "md", &format!("w{i}")).unwrap();
        }
        let mut lb2 = b.clone();
        let r2 = merge_into(&mut lb2, &a);
        let s = r2.changes[0].before.clone().unwrap();
        assert_eq!(before_of(&collect(&prior(&b, &a), &lb2, &r2.changes, 99), &lb2, &r2.changes[0].id), Some(("md".into(), "v0".into())));
        // when the merged history doesn't hold it after all (its cap full of conflicts), the
        // marker keeps its own sealed copy
        lb2.entries.get_mut(&r2.changes[0].id).unwrap().history.retain(|h| h.stamp.as_ref() != Some(&s));
        let marks2 = collect(&prior(&b, &a), &lb2, &r2.changes, 99);
        assert_eq!(marks2[0].before_copy.as_ref().map(|k| k.content.as_str()), Some("v0"));
        assert_eq!(before_of(&marks2, &lb2, &marks2[0].id), Some(("md".into(), "v0".into())));
        assert!(views(&marks2, &lb2)[0].has_before);
    }

    #[test]
    fn unknown_device_is_empty_never_an_id() {
        let mut marks = vec![mk("x", ChangeKind::Added, 1)];
        marks[0].from_device = "0123456789abcdef0123456789abcdef".into();
        name_devices(&mut marks, |_| None);
        assert_eq!(marks[0].from_device, "");
    }
}
