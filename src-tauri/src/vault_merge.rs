//! Vault sync P1: the pure, deterministic merge of two vault databases.
//!
//! [`merge`] is a join: commutative, associative and idempotent, so devices that have seen
//! the same changes hold the same database whatever order they synced in. No I/O, no clock
//! reads, no randomness. Rules, per entry (by `id`; one-sided entries are taken as they are):
//!
//! - **Live state** (content, ext, path, dir, tags, starred, updated) comes from the version
//!   with the highest `stamp` (ties: the larger `(updated, path, ext, content, dir, tags,
//!   starred)`, so the choice is total).
//! - **`trash` / `tomb`** are each the max of both registers by `(over, at)`. Afterwards the
//!   entry is a tombstone iff `tomb.over >= stamp` and trashed iff `trash.over >= stamp`
//!   (`Entry::fix_flags`): an edit concurrent with a delete wins (the remover never saw it),
//!   a delete that saw the edit wins.
//! - **Delete cut**: everything stamped `<= tomb.over` (revisions, attachments, losing
//!   versions) was seen by the delete and is dropped, also when a concurrent edit brings the
//!   entry back. A tombstone therefore carries no content, history or attachments. (Without
//!   the cut, data a delete had already wiped on one device would come back or not
//!   depending on merge order.)
//! - **History** = union of both histories plus every losing version with content
//!   (`Revision { stamp, conflict_from: Some(<device of its stamp>) }`), de-duplicated by
//!   identity (`stamp`, else `updated`; plus ext and content): one copy, normal if any copy
//!   is normal (a version some device saw being replaced is not a conflict). A conflict
//!   revision is dropped when the winner has the same (ext, content), or a normal revision
//!   at least as new has it, or a newer conflict revision has it. Newest first; the cap
//!   keeps the [`MAX_HISTORY`] best by (conflict first, newer first), like `cap_history`.
//! - **Attachments**: union by `id`; `removed` = max (removal always wins); data from the
//!   side that has it while live, wiped once removed.
//!
//! Db: `clock` = max (also over every stamp held), `legacy_imported` = OR, then the same
//! `Db::normalise` a loaded database gets.
//!
//! The laws are exact while no entry's merged history exceeds the cap. Past it, merging stays
//! commutative and deterministic, but a revision the cap dropped can come back once from a
//! replica that still holds it (as a conflict copy), so the orchestrator should simply treat
//! "merge changed something" as a normal save; a second merge with the same input is a no-op.
//! A replica fresh from local edits merges as its canonical form: conflict revisions whose
//! text is the current content, or is in a newer normal revision, are dropped (text kept).
//!
//! Two different live entries can end up at one path (both devices created `Bank.nqv`
//! offline). The merge does not rename (that needs a new stamp and would break the laws);
//! [`path_collisions`] lists them for the orchestrator to fix with a normal stamped rename.

#![allow(dead_code)] // called by the sync orchestrator (P3)

use std::collections::BTreeMap;

use serde::Serialize;
use zeroize::Zeroize;

use crate::vault_db::{Attachment, Db, Entry, Revision, DB_VERSION, MAX_HISTORY};
use crate::vault_hlc::{Hlc, Removal};

// ─── public API ──────────────────────────────────────────────────────────────

/// A losing version that the merge newly kept as a conflict revision.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MergeConflict {
    pub id: String,
    /// The entry's path after the merge.
    pub path: String,
    /// Device whose version lost (`""` for a version from before stamps existed).
    pub from_device: String,
}

/// Several non-tombstone entries with the same path and kind, in the same place (live or
/// recycle bin). `ids` are ordered oldest stamp first: the first one keeps the name.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PathCollision {
    pub path: String,
    pub dir: bool,
    pub trashed: bool,
    pub ids: Vec<String>,
}

/// What [`merge_into`] changed in the local database (for the one sync notification).
#[derive(Serialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct MergeReport {
    /// The local database differs from before (needs saving).
    pub changed: bool,
    /// Entries that were not here before (tombstones not counted).
    pub added: usize,
    /// Entries that changed and are not counted as added or removed.
    pub updated: usize,
    /// Entries that were live here and are now trashed or deleted.
    pub removed: usize,
    pub conflicts: Vec<MergeConflict>,
    pub collisions: Vec<PathCollision>,
}

/// The join of two databases. `device` and `loaded_v` (not stored) come from `a`.
pub fn merge(a: &Db, b: &Db) -> Db {
    let mut entries = BTreeMap::new();
    for (id, e) in &a.entries {
        let j = match b.entries.get(id) { Some(f) => join_entry(e, f), None => join_entry(e, e) };
        entries.insert(id.clone(), j);
    }
    for (id, f) in &b.entries {
        if !a.entries.contains_key(id) { entries.insert(id.clone(), join_entry(f, f)); }
    }
    let mut out = Db {
        v: DB_VERSION,
        entries,
        legacy_imported: a.legacy_imported || b.legacy_imported,
        clock: a.clock.clone().max(b.clock.clone()),
        device: a.device.clone(),
        loaded_v: a.loaded_v,
    };
    out.clock = out.clock.clone().max(max_stamp(&out));
    out.normalise();
    out
}

/// Merges `remote` into `local` (keeping `local.device`, `local.loaded_v`; the clock now
/// covers every remote stamp, so the next local change beats them) and says what changed.
pub fn merge_into(local: &mut Db, remote: &Db) -> MergeReport {
    let merged = merge(local, remote);
    let report = report(local, &merged);
    let (device, loaded_v) = (std::mem::take(&mut local.device), local.loaded_v);
    *local = merged;
    local.device = device;
    local.loaded_v = loaded_v;
    report
}

/// Non-tombstone entries that share a path (and kind, and live/trashed state).
pub fn path_collisions(db: &Db) -> Vec<PathCollision> {
    let mut groups: BTreeMap<(&str, bool, bool), Vec<&Entry>> = BTreeMap::new();
    for e in db.entries.values().filter(|e| !e.deleted) {
        groups.entry((e.path.as_str(), e.dir, e.is_trashed())).or_default().push(e);
    }
    groups.into_iter().filter(|(_, v)| v.len() > 1).map(|((path, dir, trashed), mut v)| {
        v.sort_by(|x, y| (&x.stamp, &x.id).cmp(&(&y.stamp, &y.id)));
        PathCollision { path: path.into(), dir, trashed, ids: v.into_iter().map(|e| e.id.clone()).collect() }
    }).collect()
}

// ─── entries ─────────────────────────────────────────────────────────────────

type RegKey<'a> = (&'a Hlc, u64, &'a str, &'a str, &'a str, bool, &'a [String], bool);

/// Total order of the live-state register.
fn reg_key(e: &Entry) -> RegKey<'_> {
    (&e.stamp, e.updated, &e.path, &e.ext, &e.content, e.dir, &e.tags, e.starred)
}

fn max_removal(a: &Option<Removal>, b: &Option<Removal>) -> Option<Removal> {
    match (a, b) {
        (Some(x), Some(y)) => Some(if (&x.over, &x.at) >= (&y.over, &y.at) { x } else { y }.clone()),
        (Some(x), None) | (None, Some(x)) => Some(x.clone()),
        (None, None) => None,
    }
}

/// Seen (and so removed) by a permanent delete whose register covers stamps up to `cut`.
fn under_cut(cut: Option<&Hlc>, s: &Hlc) -> bool {
    cut.is_some_and(|c| s <= c)
}

/// The stamp a revision is ordered and cut by (`legacy(updated)` when it has none).
fn rev_stamp(r: &Revision) -> Hlc {
    r.stamp.clone().unwrap_or_else(|| Hlc::legacy(r.updated))
}

fn join_entry(a: &Entry, b: &Entry) -> Entry {
    let win = if reg_key(a) >= reg_key(b) { a } else { b };
    let trash = max_removal(&a.trash, &b.trash);
    let tomb = max_removal(&a.tomb, &b.tomb);
    // The recycle-bin time travels with the trash register that won.
    let trashed_at = [a, b].iter().filter(|e| e.trash.is_some() && e.trash == trash).filter_map(|e| e.trashed_at).max();
    let cut = tomb.as_ref().map(|t| t.over.clone());
    let mut out = Entry {
        id: win.id.clone(),
        path: win.path.clone(),
        ext: win.ext.clone(),
        content: win.content.clone(),
        updated: win.updated,
        deleted: false,
        dir: win.dir,
        tags: win.tags.clone(),
        starred: win.starred,
        trashed_at,
        history: join_history([a, b], win, cut.as_ref()),
        attachments: join_attachments(&a.attachments, &b.attachments, cut.as_ref()),
        stamp: win.stamp.clone(),
        trash,
        tomb,
    };
    out.fix_flags();
    if out.deleted {
        out.content.zeroize();
        out.content = String::new();
        out.history.clear();
        out.attachments.clear();
    }
    out
}

// ─── history ─────────────────────────────────────────────────────────────────

/// Identity of a revision: the version it records.
fn ident(r: &Revision) -> (Option<&Hlc>, u64, &str, &str) {
    (r.stamp.as_ref(), if r.stamp.is_some() { 0 } else { r.updated }, &r.ext, &r.content)
}

fn join_history(sides: [&Entry; 2], win: &Entry, cut: Option<&Hlc>) -> Vec<Revision> {
    if win.dir { return vec![]; }
    let mut pool: Vec<Revision> = sides.iter()
        .flat_map(|e| e.history.iter())
        .filter(|r| !under_cut(cut, &rev_stamp(r)))
        .cloned()
        .collect();
    for v in sides {
        let same_as_winner = v.ext == win.ext && v.content == win.content;
        if v.dir || v.content.is_empty() || same_as_winner || under_cut(cut, &v.stamp) { continue; }
        pool.push(Revision {
            updated: v.updated,
            ext: v.ext.clone(),
            content: v.content.clone(),
            stamp: Some(v.stamp.clone()),
            conflict_from: Some(v.stamp.device.clone()),
        });
    }
    canon_history(pool, win)
}

/// De-duplicates, drops redundant conflict revisions, orders newest first and caps.
/// Dropped revisions zeroise themselves.
fn canon_history(mut pool: Vec<Revision>, win: &Entry) -> Vec<Revision> {
    // 1. one copy per identity: the max by (normal, updated, conflict_from), so a normal copy
    //    wins outright (a losing current's `updated` never leaks into it)
    let copy_key = |r: &Revision| (r.conflict_from.is_none(), r.updated, r.conflict_from.clone());
    pool.sort_by(|x, y| ident(x).cmp(&ident(y)));
    let mut h: Vec<Revision> = Vec::with_capacity(pool.len());
    for r in pool {
        match h.last_mut() {
            Some(last) if ident(last) == ident(&r) => {
                if copy_key(&r) > copy_key(last) { *last = r; }
            }
            _ => h.push(r),
        }
    }
    // 2. a conflict revision only where its content isn't kept otherwise. "At least as new"
    //    keeps this stable under the delete cut (what covers a revision outlives it).
    let keep: Vec<bool> = (0..h.len()).map(|i| {
        let r = &h[i];
        if r.conflict_from.is_none() { return true; }
        if win.ext == r.ext && win.content == r.content { return false; }
        let s = rev_stamp(r);
        !h.iter().enumerate().any(|(j, o)| {
            j != i && o.ext == r.ext && o.content == r.content
                && if o.conflict_from.is_none() { rev_stamp(o) >= s } else { rev_stamp(o) > s }
        })
    }).collect();
    retain_marked(&mut h, &keep);
    // 3. newest first (a total order)
    h.sort_by(|x, y| rec_key(y).cmp(&rec_key(x)));
    // 4. cap: conflicts first, then newest (as `vault_db::cap_history` on a sorted list)
    if h.len() > MAX_HISTORY {
        let mut idx: Vec<usize> = (0..h.len()).collect();
        idx.sort_by_key(|&i| (h[i].conflict_from.is_none(), i));
        let mut keep = vec![false; h.len()];
        for &i in idx.iter().take(MAX_HISTORY) { keep[i] = true; }
        retain_marked(&mut h, &keep);
    }
    h
}

fn rec_key(r: &Revision) -> (Hlc, u64, &str, &str, &Option<String>) {
    (rev_stamp(r), r.updated, &r.ext, &r.content, &r.conflict_from)
}

fn retain_marked<T>(v: &mut Vec<T>, keep: &[bool]) {
    let mut i = 0;
    v.retain(|_| { let k = keep[i]; i += 1; k });
}

// ─── attachments ─────────────────────────────────────────────────────────────

fn meta_key(a: &Attachment) -> (&Hlc, u64, u64, &str, &str) {
    (&a.stamp, a.added, a.size, &a.name, &a.mime)
}

fn join_attachments(a: &[Attachment], b: &[Attachment], cut: Option<&Hlc>) -> Vec<Attachment> {
    let mut by: BTreeMap<&str, Attachment> = BTreeMap::new();
    for x in a.iter().chain(b) {
        if under_cut(cut, &x.stamp) { continue; }
        match by.get_mut(x.id.as_str()) {
            None => { by.insert(&x.id, x.clone()); }
            Some(cur) => {
                // Attachments are immutable; the max keeps the choice total if copies differ.
                if meta_key(x) > meta_key(cur) {
                    cur.stamp = x.stamp.clone();
                    cur.added = x.added;
                    cur.size = x.size;
                    cur.name = x.name.clone();
                    cur.mime = x.mime.clone();
                }
                cur.removed = cur.removed.take().max(x.removed.clone());
                if x.data > cur.data { cur.data.zeroize(); cur.data = x.data.clone(); }
            }
        }
    }
    let mut v: Vec<Attachment> = by.into_values().collect();
    for att in v.iter_mut().filter(|a| a.removed.is_some()) {
        att.data.zeroize();
        att.data = String::new();
    }
    v.sort_by(|x, y| (&x.stamp, &x.id).cmp(&(&y.stamp, &y.id)));
    v
}

// ─── db ──────────────────────────────────────────────────────────────────────

/// The largest stamp held anywhere in `db` (entries, registers, attachments).
fn max_stamp(db: &Db) -> Hlc {
    let mut top = Hlc::default();
    let mut see = |s: &Hlc| if *s > top { top = s.clone(); };
    for e in db.entries.values() {
        see(&e.stamp);
        for r in [&e.trash, &e.tomb].into_iter().flatten() { see(&r.over); see(&r.at); }
        for a in &e.attachments {
            see(&a.stamp);
            if let Some(r) = &a.removed { see(r); }
        }
    }
    top
}

fn same_state(a: &Db, b: &Db) -> bool {
    a.v == b.v && a.legacy_imported == b.legacy_imported && a.clock == b.clock && a.entries == b.entries
}

fn report(local: &Db, merged: &Db) -> MergeReport {
    let mut r = MergeReport { changed: !same_state(local, merged), ..MergeReport::default() };
    for (id, m) in &merged.entries {
        let Some(l) = local.entries.get(id) else {
            if !m.deleted { r.added += 1; }
            for c in m.history.iter().filter(|c| c.conflict_from.is_some()) {
                r.conflicts.push(MergeConflict { id: id.clone(), path: m.path.clone(), from_device: c.conflict_from.clone().unwrap_or_default() });
            }
            continue;
        };
        if l.is_live() && !m.is_live() { r.removed += 1; } else if l != m { r.updated += 1; }
        for c in m.history.iter().filter(|c| c.conflict_from.is_some()) {
            if !l.history.iter().any(|o| ident(o) == ident(c)) {
                r.conflicts.push(MergeConflict { id: id.clone(), path: m.path.clone(), from_device: c.conflict_from.clone().unwrap_or_default() });
            }
        }
    }
    r.collisions = path_collisions(merged);
    r
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_db::b64_encode;
    use proptest::prelude::*;
    use std::collections::{BTreeSet, HashMap};

    /// Simulated wall clock, far beyond the real one so `Db::tick` (`max(now_ms, clock.wall)`)
    /// only ever uses the clock we set: stamps are deterministic.
    const BASE: u64 = 5_000_000_000_000;

    fn dev(name: &str) -> Db {
        let mut d = Db::new();
        d.device = name.into();
        d
    }

    fn fork(base: &Db, name: &str) -> Db {
        let mut d = base.clone();
        d.device = name.into();
        d
    }

    /// Moves `db`'s clock forward to `wall` (never back): its next stamp is `(wall, 1, device)`.
    fn at(db: &mut Db, wall: u64) {
        if wall > db.clock.wall { db.clock = Hlc { wall, counter: 0, device: db.device.clone() }; }
    }

    fn same(a: &Db, b: &Db) -> bool { same_state(a, b) }

    /// First difference between two databases (for failure messages).
    fn diff(a: &Db, b: &Db) -> String {
        if a.clock != b.clock { return format!("clock {:?} vs {:?}", a.clock, b.clock); }
        for id in a.entries.keys().chain(b.entries.keys()) {
            match (a.entries.get(id), b.entries.get(id)) {
                (Some(x), Some(y)) if x == y => {}
                (x, y) => return format!("entry {id}:
{x:#?}
vs
{y:#?}"),
            }
        }
        "same entries".into()
    }

    fn entry<'a>(db: &'a Db, path: &str) -> &'a Entry {
        db.entries.values().find(|e| e.path == path).unwrap_or_else(|| panic!("no entry at {path}"))
    }

    fn base_note(content: &str) -> Db {
        let mut base = dev("base");
        at(&mut base, BASE);
        base.put("n.nqv", "md", content).unwrap();
        base
    }

    fn contents(e: &Entry) -> Vec<(&str, Option<&str>)> {
        e.history.iter().map(|r| (r.content.as_str(), r.conflict_from.as_deref())).collect()
    }

    /// `merge(d, d)` (the canonical form of a replica) is idempotent and differs from `d` only
    /// by conflict revisions whose content is still there (local ops such as restoring a
    /// conflict version, or saving the same text again, can make a conflict redundant).
    fn check_canon(d: &Db) -> Result<(), String> {
        let c = merge(d, d);
        if !same(&merge(&c, &c), &c) { return Err(format!("canonical form not idempotent: {}", diff(&merge(&c, &c), &c))); }
        if c.clock != d.clock || c.entries.len() != d.entries.len() { return Err(format!("canon changed the db: {}", diff(&c, d))); }
        for (id, x) in &d.entries {
            let y = &c.entries[id];
            let mut strip = x.clone();
            strip.history.retain(|r| y.history.iter().any(|o| ident(o) == ident(r)));
            if strip != *y { return Err(format!("canon changed more than history: {}", diff(&c, d))); }
            for r in x.history.iter().filter(|r| !y.history.iter().any(|o| ident(o) == ident(r))) {
                let kept = (y.ext == r.ext && y.content == r.content) || y.history.iter().any(|o| o.ext == r.ext && o.content == r.content);
                if r.conflict_from.is_none() || !kept { return Err(format!("canon dropped {r:?} of {id}")); }
            }
        }
        Ok(())
    }

    fn assert_laws_pair(a: &Db, b: &Db) {
        let ab = merge(a, b);
        assert!(same(&ab, &merge(b, a)), "commutative");
        assert!(same(&merge(&ab, b), &ab) && same(&merge(&ab, a), &ab), "absorbs inputs");
        assert!(same(&merge(&ab, &ab), &ab), "idempotent");
    }

    // ─── unit tests ──────────────────────────────────────────────────────────

    #[test]
    fn concurrent_edits_newer_wins_and_the_loser_is_kept_as_a_conflict() {
        let base = base_note("v0");
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.put("n.nqv", "md", "from A").unwrap();
        at(&mut b, BASE + 20);
        b.put("n.nqv", "md", "from B").unwrap();
        assert_laws_pair(&a, &b);
        let m = merge(&a, &b);
        let e = m.get("n.nqv").unwrap();
        assert_eq!(e.content, "from B");
        assert_eq!(contents(e), vec![("from A", Some("A")), ("v0", None)], "newest first; v0 stays normal");
        assert_eq!(e.history[0].stamp.as_ref().unwrap().device, "A");
        // both devices report the same one conflict; afterwards their stamps beat both versions
        let (mut la, mut lb) = (a.clone(), b.clone());
        let ra = merge_into(&mut la, &b);
        let rb = merge_into(&mut lb, &a);
        assert!(same(&la, &lb) && la.device == "A" && lb.device == "B");
        assert_eq!(ra.conflicts, vec![MergeConflict { id: e.id.clone(), path: "n.nqv".into(), from_device: "A".into() }]);
        assert_eq!(rb.conflicts, ra.conflicts);
        assert_eq!((ra.updated, ra.added, ra.removed, ra.changed), (1, 0, 0, true));
        assert!(la.tick() > e.stamp && la.clock.device == "A");
        // syncing again changes nothing
        let again = merge_into(&mut la, &lb);
        assert_eq!(again, MergeReport::default());
    }

    #[test]
    fn a_stale_replica_is_not_a_conflict() {
        let base = base_note("v0");
        let (mut a, b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.put("n.nqv", "md", "v1").unwrap();
        let mut lb = b.clone();
        let r = merge_into(&mut lb, &a);
        let e = lb.get("n.nqv").unwrap();
        assert_eq!(e.content, "v1");
        assert_eq!(contents(e), vec![("v0", None)]);
        assert!(r.conflicts.is_empty() && r.updated == 1);
        assert!(same(&merge(&a, &b), &a), "the newer replica absorbs the stale one");
    }

    #[test]
    fn a_loser_with_the_winners_content_adds_nothing() {
        let base = base_note("v0");
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.rename("n.nqv", "m.nqv").unwrap();
        at(&mut b, BASE + 20);
        b.set_tags("n.nqv", vec!["bank".into()]).unwrap();
        let m = merge(&a, &b);
        assert_eq!(m.entries.len(), 1);
        let e = m.get("n.nqv").unwrap();
        assert_eq!((e.content.as_str(), e.tags.clone()), ("v0", vec!["bank".to_string()]), "newer change wins the register");
        assert!(e.history.is_empty());
        assert!(merge_into(&mut a.clone(), &b).conflicts.is_empty());
    }

    #[test]
    fn rename_on_one_device_and_edit_on_the_other_keep_one_entry_and_both_versions() {
        // edit newer: content wins, the renamed (old-content) version is kept as a conflict
        let base = base_note("v0");
        let id = base.get("n.nqv").unwrap().id.clone();
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.rename("n.nqv", "m.nqv").unwrap();
        at(&mut b, BASE + 20);
        b.put("n.nqv", "md", "v1").unwrap();
        let m = merge(&a, &b);
        assert_eq!(m.entries.len(), 1);
        let e = &m.entries[&id];
        assert_eq!((e.path.as_str(), e.content.as_str()), ("n.nqv", "v1"));
        assert!(e.history.iter().any(|r| r.content == "v0"));
        assert!(path_collisions(&m).is_empty());
        // rename newer: the path wins, the edit is kept as a conflict revision
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut b, BASE + 10);
        b.put("n.nqv", "md", "v1").unwrap();
        at(&mut a, BASE + 20);
        a.rename("n.nqv", "m.nqv").unwrap();
        let m = merge(&b, &a);
        let e = &m.entries[&id];
        assert_eq!((e.path.as_str(), e.content.as_str()), ("m.nqv", "v0"));
        assert_eq!(contents(e), vec![("v1", Some("B")), ("v0", None)]);
        assert_laws_pair(&a, &b);
    }

    fn trash_purge(db: &mut Db, path: &str) {
        db.trash(path).unwrap();
        db.purge(path).unwrap();
    }

    #[test]
    fn an_edit_concurrent_with_a_delete_wins() {
        let mut base = base_note("v0");
        at(&mut base, BASE + 1);
        base.put("n.nqv", "md", "v1").unwrap();
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 100); // later in wall time, but it never saw B's edit
        trash_purge(&mut a, "n.nqv");
        at(&mut b, BASE + 10);
        b.put("n.nqv", "md", "v2").unwrap();
        assert_laws_pair(&a, &b);
        let m = merge(&a, &b);
        let e = m.get("n.nqv").expect("the edit brings the note back");
        assert!(e.is_live() && !e.deleted && e.content == "v2");
        // the delete's cut: versions it had seen (v0, v1) stay deleted
        assert!(e.history.is_empty(), "{:?}", contents(e));
        assert!(e.tomb.is_some(), "the register is kept");
    }

    #[test]
    fn a_delete_that_saw_the_edit_wins() {
        let base = base_note("v0");
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut b, BASE + 10);
        b.put("n.nqv", "md", "v1").unwrap();
        b.attach_add("n.nqv", "x.txt", &b64_encode(b"file")).unwrap();
        merge_into(&mut a, &b);
        at(&mut a, BASE + 20);
        trash_purge(&mut a, "n.nqv");
        let m = merge(&a, &b);
        let e = m.entries.values().next().unwrap();
        assert!(e.deleted && e.trashed_at.is_none() && m.get("n.nqv").is_none());
        assert!(e.content.is_empty() && e.history.is_empty() && e.attachments.is_empty(), "a tombstone carries no data");
        let r = merge_into(&mut b.clone(), &a);
        assert_eq!((r.removed, r.added), (1, 0));
        assert_laws_pair(&a, &b);
    }

    #[test]
    fn trash_against_an_edit() {
        // concurrent: the edit wins
        let base = base_note("v0");
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 50);
        a.trash("n.nqv").unwrap();
        at(&mut b, BASE + 10);
        b.put("n.nqv", "md", "v1").unwrap();
        let m = merge(&a, &b);
        assert!(m.get("n.nqv").is_some_and(|e| e.content == "v1") && m.list_trash().is_empty());
        assert_laws_pair(&a, &b);
        // a trash that saw the edit wins, content kept in the bin
        let mut a2 = fork(&base, "A");
        merge_into(&mut a2, &b);
        at(&mut a2, BASE + 60);
        a2.trash_at("n.nqv", 1234).unwrap();
        let m = merge(&b, &a2);
        let e = entry(&m, "n.nqv");
        assert!(e.is_trashed() && e.content == "v1" && e.trashed_at == Some(1234));
        assert_laws_pair(&a2, &b);
    }

    #[test]
    fn restore_beats_a_concurrent_purge_and_a_later_trash_beats_a_stale_copy() {
        let mut base = base_note("v0");
        at(&mut base, BASE + 1);
        base.trash("n.nqv").unwrap();
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.restore("n.nqv").unwrap();
        at(&mut b, BASE + 20);
        b.purge("n.nqv").unwrap();
        let m = merge(&a, &b);
        assert!(m.get("n.nqv").is_some_and(|e| e.content == "v0" && e.is_live()));
        assert_laws_pair(&a, &b);
        // restore then trash again on A: trashed, whatever B (still in the bin) says
        let mut a2 = a.clone();
        at(&mut a2, BASE + 30);
        a2.trash("n.nqv").unwrap();
        let m = merge(&base, &a2);
        assert!(entry(&m, "n.nqv").is_trashed());
        assert_laws_pair(&base, &a2);
    }

    #[test]
    fn attachments_added_on_both_sides_are_kept() {
        let base = base_note("v0");
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.attach_add("n.nqv", "a.txt", &b64_encode(b"aaa")).unwrap();
        at(&mut b, BASE + 20);
        b.attach_add("n.nqv", "b.txt", &b64_encode(b"bbb")).unwrap();
        b.put("n.nqv", "md", "v1").unwrap();
        let m = merge(&a, &b);
        let names: Vec<String> = m.attach_list("n.nqv").unwrap().into_iter().map(|x| x.name).collect();
        assert_eq!(names, vec!["a.txt", "b.txt"]);
        assert!(m.get("n.nqv").unwrap().attachments.iter().all(|x| !x.data.is_empty()));
        assert_laws_pair(&a, &b);
    }

    #[test]
    fn an_attachment_removal_always_wins() {
        let mut base = base_note("v0");
        at(&mut base, BASE + 1);
        let id = base.attach_add("n.nqv", "a.txt", &b64_encode(b"secret")).unwrap().id;
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.attach_remove("n.nqv", &id).unwrap();
        at(&mut b, BASE + 20); // B's later edit doesn't bring it back
        b.put("n.nqv", "md", "v1").unwrap();
        let m = merge(&a, &b);
        assert!(m.attach_list("n.nqv").unwrap().is_empty());
        let rec = &m.get("n.nqv").unwrap().attachments[0];
        assert!(rec.removed.is_some() && rec.data.is_empty());
        assert_eq!(m.get("n.nqv").unwrap().content, "v1");
        assert_laws_pair(&a, &b);
    }

    #[test]
    fn a_tombstone_wipes_content_history_and_attachments() {
        let mut base = base_note("v0");
        at(&mut base, BASE + 1);
        base.put("n.nqv", "md", "v1").unwrap();
        base.attach_add("n.nqv", "a.txt", &b64_encode(b"x")).unwrap();
        let (mut a, b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        trash_purge(&mut a, "n.nqv");
        for m in [merge(&a, &b), merge(&b, &a)] {
            let e = m.entries.values().next().unwrap();
            assert!(e.deleted && e.content.is_empty() && e.history.is_empty() && e.attachments.is_empty());
            assert_eq!(e.path, "n.nqv", "the record (path, tags) stays");
        }
    }

    #[test]
    fn the_history_cap_drops_normal_revisions_before_conflicts() {
        let base = base_note("v0");
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut b, BASE + 5);
        b.put("n.nqv", "md", "B's edit").unwrap();
        for i in 1..=12u64 {
            at(&mut a, BASE + 10 + i);
            a.put("n.nqv", "md", &format!("a{i}")).unwrap();
        }
        assert_eq!(a.get("n.nqv").unwrap().history.len(), MAX_HISTORY);
        let m = merge(&a, &b);
        let e = m.get("n.nqv").unwrap();
        assert_eq!(e.history.len(), MAX_HISTORY);
        assert!(e.history.iter().any(|r| r.content == "B's edit" && r.conflict_from.as_deref() == Some("B")));
        assert_eq!(e.history[0].content, "a11", "newest first");
        assert!(!e.history.iter().any(|r| r.content == "a2"), "the oldest normal one went");
        assert_laws_pair(&a, &b);
        // a later local edit (P0's cap_history) keeps the conflict too
        let mut l = m.clone();
        l.device = "A".into();
        at(&mut l, BASE + 100);
        l.put("n.nqv", "md", "a13").unwrap();
        assert!(l.get("n.nqv").unwrap().history.iter().any(|r| r.conflict_from.is_some()));
        assert!(same(&merge(&l, &l), &l));
    }

    #[test]
    fn re_merging_adds_no_duplicate_history() {
        let base = base_note("v0");
        let (mut a, mut b) = (fork(&base, "A"), fork(&base, "B"));
        at(&mut a, BASE + 10);
        a.put("n.nqv", "md", "A").unwrap();
        at(&mut b, BASE + 20);
        b.put("n.nqv", "md", "B").unwrap();
        let mut la = a.clone();
        merge_into(&mut la, &b);
        for _ in 0..3 {
            assert_eq!(merge_into(&mut la, &b), MergeReport::default());
            assert_eq!(merge_into(&mut la, &a), MergeReport::default());
        }
        assert_eq!(la.get("n.nqv").unwrap().history.len(), 2);
        // B pulls A's merged copy: the conflict comes through once, still a conflict
        let mut lb = b.clone();
        merge_into(&mut lb, &la);
        assert!(same(&la, &lb));
        // B keeps editing; A pulls: the conflict stays, the old "B" version is normal history
        at(&mut lb, BASE + 30);
        lb.put("n.nqv", "md", "B2").unwrap();
        let r = merge_into(&mut la, &lb);
        assert!(r.conflicts.is_empty());
        assert_eq!(contents(la.get("n.nqv").unwrap()), vec![("B", None), ("A", Some("A")), ("v0", None)]);
    }

    #[test]
    fn identical_content_from_two_devices_keeps_one_conflict() {
        let base = base_note("v0");
        let (mut a, mut b, mut c) = (fork(&base, "A"), fork(&base, "B"), fork(&base, "C"));
        at(&mut a, BASE + 10);
        a.put("n.nqv", "md", "same").unwrap();
        at(&mut b, BASE + 11);
        b.put("n.nqv", "md", "same").unwrap();
        at(&mut c, BASE + 20);
        c.put("n.nqv", "md", "C").unwrap();
        let m = merge(&merge(&a, &b), &c);
        assert!(same(&m, &merge(&a, &merge(&b, &c))));
        assert_eq!(contents(m.get("n.nqv").unwrap()), vec![("same", Some("B")), ("v0", None)]);
    }

    #[test]
    fn path_collisions_are_reported_not_renamed() {
        let mut a = dev("A");
        at(&mut a, BASE);
        a.put("Bank.nqv", "login", "a").unwrap();
        let mut b = dev("B");
        at(&mut b, BASE + 5);
        b.put("Bank.nqv", "login", "b").unwrap();
        b.put("Other.nqv", "md", "o").unwrap();
        let m = merge(&a, &b);
        let c = path_collisions(&m);
        let (ida, idb) = (entry(&a, "Bank.nqv").id.clone(), entry(&b, "Bank.nqv").id.clone());
        assert_eq!(c, vec![PathCollision { path: "Bank.nqv".into(), dir: false, trashed: false, ids: vec![ida, idb.clone()] }]);
        assert_eq!(m.entries.values().filter(|e| e.path == "Bank.nqv").count(), 2, "nothing renamed");
        let r = merge_into(&mut a.clone(), &b);
        assert_eq!((r.added, r.collisions.len()), (2, 1));
        // the orchestrator's fix: a normal stamped rename of the newer one
        let mut fixed = m.clone();
        fixed.device = "A".into();
        at(&mut fixed, BASE + 50);
        let stamp = fixed.tick();
        let e = fixed.entries.get_mut(&idb).unwrap();
        e.path = "Bank (B).nqv".into();
        e.stamp = stamp;
        assert!(path_collisions(&fixed).is_empty());
        assert!(path_collisions(&merge(&fixed, &b)).is_empty(), "the rename wins over the old copy");
    }

    #[test]
    fn db_fields_join() {
        let mut a = base_note("v0");
        a.device = "A".into();
        a.legacy_imported = true;
        let mut b = dev("B");
        at(&mut b, BASE + 1000);
        b.put("x.nqv", "md", "x").unwrap();
        let m = merge(&a, &b);
        assert!(m.legacy_imported && m.v == DB_VERSION && m.entries.len() == 2);
        assert_eq!(m.clock, b.clock);
        assert_eq!(m.device, "A");
        let empty = Db::new();
        assert!(same(&merge(&a, &empty), &a) && same(&merge(&empty, &a), &a));
    }

    #[test]
    fn legacy_unstamped_revisions_merge() {
        let mut a = base_note("v1");
        a.device = "A".into();
        let e = a.entries.values_mut().next().unwrap();
        e.history.push(Revision { updated: 7, ext: "md".into(), content: "ancient".into(), stamp: None, conflict_from: None });
        let mut b = fork(&a, "B");
        at(&mut b, BASE + 10);
        b.put("n.nqv", "md", "v2").unwrap();
        let m = merge(&a, &b);
        assert_eq!(contents(m.get("n.nqv").unwrap()), vec![("v1", None), ("ancient", None)]);
        assert!(same(&merge(&a, &a), &a));
        assert_laws_pair(&a, &b);
    }

    // ─── random replicas ─────────────────────────────────────────────────────

    const FILES: [&str; 5] = ["a.nqv", "b.nqv", "F/c.nqv", "G/c.nqv", "F/d.nqv"];
    const DIRS: [&str; 2] = ["F", "G"];

    fn any_path(i: u8) -> &'static str {
        let i = i as usize % (FILES.len() + DIRS.len());
        if i < FILES.len() { FILES[i] } else { DIRS[i - FILES.len()] }
    }

    #[derive(Clone, Debug)]
    enum Op {
        Put(u8, u8),
        Rename(u8, u8),
        Trash(u8),
        Restore(u8),
        Purge(u8),
        EmptyTrash,
        Tags(u8, u8),
        Star(u8, bool),
        AttachAdd(u8),
        AttachRemove(u8, u8),
        HistoryRestore(u8, u8),
        Mkdir(u8),
        Duplicate(u8),
    }

    #[derive(Clone, Debug)]
    enum Step {
        Op(u8, Op),
        /// `Sync(i, j)`: device i pulls device j.
        Sync(u8, u8),
    }

    fn op() -> impl Strategy<Value = Op> {
        prop_oneof![
            7 => (any::<u8>(), any::<u8>()).prop_map(|(p, k)| Op::Put(p, k)),
            2 => (any::<u8>(), any::<u8>()).prop_map(|(f, t)| Op::Rename(f, t)),
            3 => any::<u8>().prop_map(Op::Trash),
            2 => any::<u8>().prop_map(Op::Restore),
            3 => any::<u8>().prop_map(Op::Purge),
            1 => Just(Op::EmptyTrash),
            2 => (any::<u8>(), any::<u8>()).prop_map(|(p, k)| Op::Tags(p, k)),
            1 => (any::<u8>(), any::<bool>()).prop_map(|(p, s)| Op::Star(p, s)),
            2 => any::<u8>().prop_map(Op::AttachAdd),
            2 => (any::<u8>(), any::<u8>()).prop_map(|(p, i)| Op::AttachRemove(p, i)),
            1 => (any::<u8>(), any::<u8>()).prop_map(|(p, i)| Op::HistoryRestore(p, i)),
            1 => any::<u8>().prop_map(Op::Mkdir),
            1 => any::<u8>().prop_map(Op::Duplicate),
        ]
    }

    fn steps(n: u8, len: std::ops::Range<usize>) -> impl Strategy<Value = Vec<Step>> {
        prop::collection::vec(
            prop_oneof![
                4 => (0..n, op()).prop_map(|(d, o)| Step::Op(d, o)),
                1 => (0..n, 0..n).prop_map(|(i, j)| Step::Sync(i, j)),
            ],
            len,
        )
    }

    /// Applies one op through the real `Db` API (errors are fine: the op just doesn't apply).
    fn apply(db: &mut Db, op: &Op, seq: usize) {
        let file = |p: u8| FILES[p as usize % FILES.len()];
        let _ = match *op {
            Op::Put(p, k) => {
                let content = match k % 5 { 0 => "shared".to_string(), 1 => String::new(), _ => format!("{}#{seq}", db.device) };
                db.put(file(p), if k % 7 == 0 { "login" } else { "md" }, &content)
            }
            Op::Rename(f, t) => db.rename(any_path(f), any_path(t)),
            Op::Trash(p) => db.trash(any_path(p)),
            Op::Restore(p) => db.restore(any_path(p)),
            Op::Purge(p) => db.purge(any_path(p)),
            Op::EmptyTrash => { db.empty_trash(); Ok(()) }
            Op::Tags(p, k) => db.set_tags(any_path(p), if k % 4 == 3 { vec![] } else { vec![format!("t{}", k % 4)] }),
            Op::Star(p, s) => db.set_starred(any_path(p), s),
            Op::AttachAdd(p) => {
                let data = b64_encode(format!("{}@{seq}", db.device).as_bytes());
                db.attach_add(file(p), &format!("f{seq}.txt"), &data).map(|_| ())
            }
            Op::AttachRemove(p, i) => match db.attach_list(file(p)) {
                Ok(l) if !l.is_empty() => { let id = l[i as usize % l.len()].id.clone(); db.attach_remove(file(p), &id) }
                _ => Ok(()),
            },
            Op::HistoryRestore(p, i) => match db.history_list(file(p)) {
                Ok(l) if !l.is_empty() => db.history_restore(file(p), i as usize % l.len()),
                _ => Ok(()),
            },
            Op::Mkdir(d) => db.mkdir(DIRS[d as usize % DIRS.len()]),
            Op::Duplicate(p) => db.duplicate(file(p)).map(|_| ()),
        };
    }

    /// Every content version of every entry seen anywhere during a run, keyed by
    /// (entry id, ext, content), with all the stamps it was seen at.
    #[derive(Default)]
    struct Seen {
        versions: BTreeMap<(String, String, String), BTreeSet<Hlc>>,
        /// Entries whose history reached the cap somewhere (revisions may legitimately drop).
        capped: BTreeSet<String>,
    }

    impl Seen {
        fn record(&mut self, db: &Db) {
            for (id, e) in &db.entries {
                if e.history.len() >= MAX_HISTORY { self.capped.insert(id.clone()); }
                if !e.dir && !e.deleted && !e.content.is_empty() {
                    self.versions.entry((id.clone(), e.ext.clone(), e.content.clone())).or_default().insert(e.stamp.clone());
                }
                for r in &e.history {
                    self.versions.entry((id.clone(), r.ext.clone(), r.content.clone())).or_default().insert(rev_stamp(r));
                }
            }
        }

        /// No revision lost: every version is the winner's content or in its history, unless
        /// the entry is a tombstone, a delete saw that version (stamp <= tomb.over), or the
        /// history cap was reached.
        fn check(&self, db: &Db) -> Result<(), String> {
            for ((id, ext, content), stamps) in &self.versions {
                if self.capped.contains(id) { continue; }
                let Some(e) = db.entries.get(id) else { return Err(format!("entry {id} vanished")) };
                if e.deleted || e.history.len() >= MAX_HISTORY { continue; }
                let cut = e.tomb.as_ref().map(|t| &t.over);
                if stamps.iter().all(|s| cut.is_some_and(|c| s <= c)) { continue; }
                let here = (e.ext == *ext && e.content == *content) || e.history.iter().any(|r| r.ext == *ext && r.content == *content);
                if !here { return Err(format!("lost {content:?} ({ext}) of {} ({id})", e.path)); }
            }
            Ok(())
        }
    }

    struct Sim {
        devs: Vec<Db>,
        skew: Vec<i64>,
        seen: Seen,
        /// Devices that don't sync until the final round.
        offline: BTreeSet<usize>,
    }

    impl Sim {
        fn new(n: usize, base_ops: &[Op], skew: Vec<i64>) -> Sim {
            // every file exists on all devices from the start, then a few random base ops
            let mut base = dev("base");
            at(&mut base, BASE);
            for f in FILES { base.put(f, "md", &format!("base {f}")).unwrap(); }
            for (i, o) in base_ops.iter().enumerate() {
                at(&mut base, BASE + 1 + i as u64);
                apply(&mut base, o, i);
            }
            let devs = (0..n).map(|i| fork(&base, &format!("d{i}"))).collect();
            let mut s = Sim { devs, skew, seen: Seen::default(), offline: BTreeSet::new() };
            s.seen.record(&base);
            s
        }

        fn wall(&self, d: usize, t: usize) -> u64 {
            (BASE as i64 + 100_000 + t as i64 * 1000 + self.skew[d]) as u64
        }

        fn run(&mut self, steps: &[Step]) {
            for (t, s) in steps.iter().enumerate() { self.run_one(t, s); }
        }

        fn run_one(&mut self, t: usize, s: &Step) {
            let n = self.devs.len();
            {
                match s {
                    Step::Op(d, o) => {
                        let d = *d as usize % n;
                        let w = self.wall(d, t);
                        at(&mut self.devs[d], w);
                        apply(&mut self.devs[d], o, t);
                        self.seen.record(&self.devs[d]);
                    }
                    Step::Sync(i, j) => {
                        let (i, j) = (*i as usize % n, *j as usize % n);
                        if i == j || self.offline.contains(&i) || self.offline.contains(&j) { return; }
                        let remote = self.devs[j].clone();
                        merge_into(&mut self.devs[i], &remote);
                        self.seen.record(&self.devs[i]);
                    }
                }
            }
        }

        /// Rounds of everyone pulling everyone (fixed order) until all replicas are identical
        /// (two rounds always suffice for a join; a few more are allowed past the history cap).
        fn sync_all(&mut self) -> Result<(), String> {
            self.offline.clear();
            let n = self.devs.len();
            let mut rounds = 0;
            while rounds < 2 || self.devs[1..].iter().any(|d| !same(d, &self.devs[0])) {
                if rounds == 6 { return Err(format!("replicas did not converge: {}", diff(&self.devs[0], &self.devs[1]))); }
                for i in 0..n {
                    for j in 0..n {
                        if i == j { continue; }
                        let remote = self.devs[j].clone();
                        merge_into(&mut self.devs[i], &remote);
                    }
                }
                rounds += 1;
            }
            if rounds > 2 && !at_cap(&[&self.devs[0]]) { return Err(format!("needed {rounds} rounds below the cap")); }
            let again = merge(&self.devs[0], &self.devs[n - 1]);
            if !same(&again, &self.devs[0]) { return Err("converged state is not a fixpoint".into()); }
            self.seen.check(&self.devs[0])
        }
    }

    fn at_cap(dbs: &[&Db]) -> bool {
        dbs.iter().any(|d| d.entries.values().any(|e| e.history.len() >= MAX_HISTORY))
    }

    /// Associativity (and order independence) of three replicas. Exact whenever the history
    /// cap doesn't fire; when it does, a conflict revision that took a slot can later be made
    /// redundant (e.g. by a winner with the same text), so the laws are only checked without it.
    fn check_assoc(a: &Db, b: &Db, c: &Db) -> Result<bool, String> {
        let (ab, bc, ac) = (merge(a, b), merge(b, c), merge(a, c));
        let (l, r, o) = (merge(&ab, c), merge(a, &bc), merge(&ac, b));
        if at_cap(&[&ab, &bc, &ac, &l, &r, &o]) { return Ok(false); }
        if !same(&l, &r) { return Err(format!("not associative: {}", diff(&l, &r))); }
        if !same(&l, &o) { return Err(format!("order dependent: {}", diff(&l, &o))); }
        Ok(true)
    }

    /// `NQ_MERGE_CASES=<n>` runs every property `n` times instead (deep local runs).
    fn cfg(cases: u32) -> ProptestConfig {
        let cases = std::env::var("NQ_MERGE_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(cases);
        ProptestConfig { cases, failure_persistence: None, ..ProptestConfig::default() }
    }

    fn skews(n: usize) -> impl Strategy<Value = Vec<i64>> {
        const H: i64 = 3_600_000;
        prop::collection::vec(prop_oneof![3 => Just(0i64), 1 => -3 * H..3 * H], n)
    }

    proptest! {
        #![proptest_config(cfg(256))]

        /// Commutative, associative, idempotent, absorbing, and no revision lost, over three
        /// replicas built from a common base by random ops and random partial syncs.
        #[test]
        fn merge_is_a_join(base_ops in prop::collection::vec(op(), 0..6), st in steps(3, 0..36), skew in skews(3)) {
            let mut sim = Sim::new(3, &base_ops, skew);
            sim.run(&st);
            let (a, b, c) = (&sim.devs[0], &sim.devs[1], &sim.devs[2]);
            let ab = merge(a, b);
            prop_assert!(same(&ab, &merge(b, a)), "commutative");
            for d in [a, b, c] { if let Err(e) = check_canon(d) { prop_assert!(false, "{}", e); } }
            prop_assert!(same(&merge(&merge(a, a), b), &ab), "a replica merges as its canonical form");
            prop_assert!(same(&merge(&ab, &ab), &ab), "idempotent on a merge");
            if !at_cap(&[&ab]) {
                prop_assert!(same(&merge(&ab, b), &ab) && same(&merge(&ab, a), &ab), "absorbs its inputs");
            }
            if let Err(e) = check_assoc(a, b, c) { prop_assert!(false, "{}", e); }
            let left = merge(&ab, c);
            // no revision lost in a merge of the three current states
            let mut seen = Seen::default();
            for d in [a, b, c] { seen.record(d); }
            if let Err(e) = seen.check(&left) { prop_assert!(false, "{}", e); }
            // stays a valid database: idempotent normalise, clock above every stamp
            let mut n = left.clone();
            n.normalise();
            prop_assert!(same(&n, &left));
            prop_assert!(left.clock >= max_stamp(&left));
        }

        /// Two devices, random ops and syncs, then a full sync: identical state, nothing lost.
        #[test]
        fn two_device_gossip_converges(base_ops in prop::collection::vec(op(), 0..6), st in steps(2, 0..40), skew in skews(2)) {
            let mut sim = Sim::new(2, &base_ops, skew);
            sim.run(&st);
            if let Err(e) = sim.sync_all() { prop_assert!(false, "{}", e); }
        }

        /// Three devices (skewed clocks allowed), random pairwise syncs, then all-to-all.
        #[test]
        fn three_device_gossip_converges(base_ops in prop::collection::vec(op(), 0..6), st in steps(3, 0..48), skew in skews(3)) {
            let mut sim = Sim::new(3, &base_ops, skew);
            sim.run(&st);
            if let Err(e) = sim.sync_all() { prop_assert!(false, "{}", e); }
        }

        /// Device 2 is offline (and hours ahead or behind) for the whole run, then rejoins.
        #[test]
        fn an_offline_device_rejoins(base_ops in prop::collection::vec(op(), 1..6), st in steps(3, 0..48),
                                     ahead in prop_oneof![Just(-6 * 3_600_000i64), Just(6 * 3_600_000i64)]) {
            let mut sim = Sim::new(3, &base_ops, vec![0, 0, ahead]);
            sim.offline.insert(2);
            sim.run(&st);
            if let Err(e) = sim.sync_all() { prop_assert!(false, "{}", e); }
        }
    }

    // Longer runs that also hit the history cap: commutative, idempotent, absorbing, and the
    // gossip still converges.
    proptest! {
        #![proptest_config(cfg(96))]
        #[test]
        fn laws_hold_past_the_history_cap(st in steps(3, 60..140), skew in skews(3)) {
            let mut sim = Sim::new(3, &[], skew);
            sim.run(&st);
            let (a, b, c) = (&sim.devs[0], &sim.devs[1], &sim.devs[2]);
            let ab = merge(a, b);
            prop_assert!(same(&ab, &merge(b, a)), "commutative");
            if let Err(e) = check_canon(a) { prop_assert!(false, "{}", e); }
            for x in [a, b] {
                let again = merge(&ab, x);
                if at_cap(&[&ab]) {
                    // a revision the cap dropped can come back once (as the copy `x` still
                    // holds); the next merge is then a fixpoint
                    prop_assert!(same(&merge(&again, x), &again), "absorbs after one more merge");
                } else {
                    prop_assert!(same(&again, &ab), "absorbs: {}", diff(&again, &ab));
                }
            }
            if let Err(e) = check_assoc(a, b, c) { prop_assert!(false, "{}", e); }
            if let Err(e) = sim.sync_all() { prop_assert!(false, "{}", e); }
        }
    }

    /// Deterministic 3-device scenario with skewed clocks: a device hours ahead wins the
    /// register, but nothing written on the others is lost and all converge.
    #[test]
    fn skewed_clocks_converge_without_loss() {
        let base = base_note("v0");
        let mut d: Vec<Db> = ["A", "B", "C"].iter().map(|n| fork(&base, n)).collect();
        at(&mut d[0], BASE + 10);
        d[0].put("n.nqv", "md", "A1").unwrap();
        at(&mut d[1], BASE + 6 * 3_600_000); // six hours ahead
        d[1].put("n.nqv", "md", "B1").unwrap();
        at(&mut d[2], BASE + 20);
        d[2].put("n.nqv", "md", "C1").unwrap();
        let (r0, r2) = (d[1].clone(), d[1].clone());
        merge_into(&mut d[0], &r0);
        at(&mut d[0], BASE + 30); // A's clock now follows B's
        d[0].put("n.nqv", "md", "A2").unwrap();
        merge_into(&mut d[2], &r2);
        let snap: Vec<Db> = d.clone();
        for i in 0..3 { for j in 0..3 { if i != j { merge_into(&mut d[i], &snap[j]); } } }
        let snap: Vec<Db> = d.clone();
        for i in 0..3 { for j in 0..3 { if i != j { merge_into(&mut d[i], &snap[j]); } } }
        assert!(same(&d[0], &d[1]) && same(&d[1], &d[2]));
        let e = d[0].get("n.nqv").unwrap();
        assert_eq!(e.content, "A2", "A edited after seeing B's stamp");
        let mut kept: Vec<&str> = e.history.iter().map(|r| r.content.as_str()).collect();
        kept.sort();
        assert_eq!(kept, vec!["A1", "B1", "C1", "v0"]);
        let conflicts: HashMap<&str, Option<&str>> = e.history.iter().map(|r| (r.content.as_str(), r.conflict_from.as_deref())).collect();
        assert_eq!(conflicts["A1"], Some("A"));
        assert_eq!(conflicts["C1"], Some("C"));
        assert_eq!(conflicts["B1"], None, "A saw B1 before replacing it");
    }
}
