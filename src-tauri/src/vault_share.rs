//! Sharing items: a "share file" is a small vault of its own (`NQB2`, see `vault_backup`), made with a password
//! chosen just for it, that holds copies of the chosen items and the rules for using it. The rules live inside the
//! encrypted database, so nobody can change them without the password (and a changed byte stops the file opening).
//!
//! What a share holds, and what it leaves out, on purpose:
//!  * the chosen notes and folders (a chosen folder takes everything in it; every note keeps its folders),
//!  * attachments only when asked for,
//!  * never the history (old versions can hold old passwords), the recycle bin, tags or stars,
//!  * new random ids, so nothing of the sender's vault identifies the copies, and a second import of the same
//!    file finds the same ids instead of making duplicates.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::vault_core::{self as vc, KdfParams, VaultKey, VaultMeta};
use crate::vault_db::{self as vdb, Db, Entry, ShareMerge};

/// The most imports one share file can allow.
pub const MAX_IMPORTS_LIMIT: u32 = 100;
/// How long imported items may live: at least an hour, at most a year.
pub const MIN_ITEM_LIFE_HOURS: u32 = 1;
pub const MAX_ITEM_LIFE_HOURS: u32 = 365 * 24;
const HOUR_MS: u64 = 3_600_000;

/// The rules of a share file, kept (sealed) inside it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SharePolicy {
    /// 32 hex chars, random per share file: what an importing vault remembers to count imports.
    pub share_id: String,
    /// Unix ms when the file was made.
    pub created_at: u64,
    /// How many times the file may be imported.
    pub max_imports: u32,
    /// The file can't be imported after this time (Unix ms); `None` = no end.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub valid_until: Option<u64>,
    /// Imported items destroy themselves this long after the import (ms); `None` = they stay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_life_ms: Option<u64>,
    /// The file is deleted after its last import.
    #[serde(default)]
    pub delete_file: bool,
}

impl SharePolicy {
    /// Checks a policy made for `now` (Unix ms) before a file is written.
    pub fn validate(&self, now: u64) -> Result<(), String> {
        if self.share_id.len() != 32 || !self.share_id.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("The share id isn't valid.".into());
        }
        if self.max_imports == 0 || self.max_imports > MAX_IMPORTS_LIMIT {
            return Err(format!("It can be imported between 1 and {MAX_IMPORTS_LIMIT} times."));
        }
        if self.valid_until.is_some_and(|t| t <= now) {
            return Err("The end date has to be in the future.".into());
        }
        if let Some(ms) = self.item_life_ms {
            let hours = ms / HOUR_MS;
            if ms % HOUR_MS != 0 || hours < MIN_ITEM_LIFE_HOURS as u64 || hours > MAX_ITEM_LIFE_HOURS as u64 {
                return Err("Imported items can last from 1 hour to 1 year.".into());
            }
        }
        Ok(())
    }
}

/// What a selection holds, for the export prompt.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SharePreview {
    pub notes: u32,
    pub folders: u32,
    pub attachments: u32,
    pub attachment_bytes: u64,
    pub content_bytes: u64,
}

/// The live entries a selection of paths stands for: each path itself and everything under it, plus the folders
/// above every note so it keeps its place. Sorted by path; an unknown path is an error.
fn selected<'a>(db: &'a Db, paths: &[String]) -> Result<Vec<&'a Entry>, String> {
    let live = || db.entries.values().filter(|e| e.is_live());
    let mut ids: std::collections::BTreeSet<&str> = Default::default();
    for p in paths {
        let rel = p.trim_matches('/');
        if rel.is_empty() {
            return Err("Choose what to share.".into());
        }
        let under = format!("{rel}/");
        let mut any = false;
        for e in live().filter(|e| e.path == rel || e.path.starts_with(&under)) {
            ids.insert(e.id.as_str());
            any = true;
        }
        if !any {
            // A folder that only exists because notes sit in it (it has no entry of its own).
            let implied = live().any(|e| e.path.starts_with(&under));
            if !implied {
                return Err(format!("\"{rel}\" isn't in the vault."));
            }
        }
    }
    let mut out: Vec<&Entry> = ids.iter().filter_map(|id| db.entries.get(*id)).collect();
    // What came from a share carries its own end of life: passing it on would leave that behind.
    let imported = out.iter().filter(|e| !e.dir && e.expires_at.is_some()).count();
    if imported > 0 {
        return Err(format!("{imported} of the chosen {} came from a share and can't be shared again.", if imported == 1 { "note" } else { "notes" }));
    }
    // Folders above the chosen notes.
    let mut above: Vec<String> = vec![];
    for e in &out {
        for (i, _) in e.path.match_indices('/') {
            above.push(e.path[..i].to_string());
        }
    }
    above.sort();
    above.dedup();
    for d in above {
        if let Some(f) = live().find(|e| e.dir && e.path == d) {
            if !out.iter().any(|x| x.id == f.id) {
                out.push(f);
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    if !out.iter().any(|e| !e.dir) {
        return Err("There are no notes in what you chose.".into());
    }
    Ok(out)
}

/// What a selection holds (notes, folders, attachments and their size).
pub fn preview(db: &Db, paths: &[String], attachments: bool) -> Result<SharePreview, String> {
    let sel = selected(db, paths)?;
    let mut out = SharePreview { notes: 0, folders: 0, attachments: 0, attachment_bytes: 0, content_bytes: 0 };
    for e in sel {
        if e.dir {
            out.folders += 1;
            continue;
        }
        out.notes += 1;
        out.content_bytes += e.content.len() as u64;
        if attachments {
            for a in e.live_attachments() {
                out.attachments += 1;
                out.attachment_bytes += a.size;
            }
        }
    }
    Ok(out)
}

/// The database of a share file: copies of the chosen items under new ids, and the rules.
pub fn build_share_db(src: &Db, paths: &[String], attachments: bool, policy: SharePolicy) -> Result<Db, String> {
    let mut db = Db::new();
    for e in selected(src, paths)? {
        let copy = e.for_share(attachments);
        db.entries.insert(copy.id.clone(), copy);
    }
    db.share = Some(policy);
    db.normalise();
    Ok(db)
}

/// A whole share file (`NQB2`): the database above, sealed with `key`, next to `meta` (the key file made from the
/// share password).
pub fn make_share_container(src: &Db, paths: &[String], attachments: bool, policy: SharePolicy, meta: &VaultMeta, key: &VaultKey) -> Result<Vec<u8>, String> {
    let db = build_share_db(src, paths, attachments, policy)?;
    let id = meta.vault_id_bytes().map_err(|e| e.to_string())?;
    let sealed = db.seal(key, &id)?;
    Ok(crate::vault_backup::build_container_of(crate::vault_backup::Kind::Share, meta.to_json().as_bytes(), &sealed))
}

/// The share password must not be the master password (the file would then open with it), and the share's own
/// vault is made from it (so a weak one is refused). Runs Argon2: call it off the main thread.
pub fn make_share_key(own: &VaultMeta, share_password: &str, kdf: KdfParams) -> Result<(VaultMeta, VaultKey), String> {
    if vc::unlock_with_password(own, share_password).is_ok() {
        return Err("Use a different password than your master password.".into());
    }
    let (meta, key, _recovery) = vc::create_vault(share_password, kdf).map_err(|e| e.to_string())?;
    Ok((meta, key))
}

// ─── importing ───────────────────────────────────────────────────────────────

/// How far behind the latest time this vault has seen the clock may be before an import is refused (clocks drift).
pub const CLOCK_SLACK_MS: u64 = 10 * 60 * 1000;

/// Why a share file can't be imported (here, now).
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ShareProblem {
    /// The file's end date has passed.
    Expired,
    /// It was imported as often as it allows.
    NoImportsLeft,
    /// This PC's clock is behind what the vault has already seen.
    ClockBehind,
}

impl ShareProblem {
    pub fn code(self) -> &'static str {
        match self {
            ShareProblem::Expired => "expired",
            ShareProblem::NoImportsLeft => "noImportsLeft",
            ShareProblem::ClockBehind => "clockBehind",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            ShareProblem::Expired => "This share file has expired.",
            ShareProblem::NoImportsLeft => "This share file can't be imported again.",
            ShareProblem::ClockBehind => "The date and time on this PC are behind. Fix them, then try again.",
        }
    }
}

/// Whether a share file may be imported into a vault where it was imported `uses` times and that has seen time up
/// to `seen_ms`, with the clock at `sys_now`. The end date is judged by the later of the clock and what was seen,
/// so setting the clock back doesn't reopen a file.
pub fn check_policy(policy: &SharePolicy, uses: u32, sys_now: u64, seen_ms: u64) -> Result<(), ShareProblem> {
    if sys_now.saturating_add(CLOCK_SLACK_MS) < seen_ms {
        return Err(ShareProblem::ClockBehind);
    }
    let now = sys_now.max(seen_ms);
    if policy.valid_until.is_some_and(|t| t <= now) {
        return Err(ShareProblem::Expired);
    }
    if uses >= policy.max_imports {
        return Err(ShareProblem::NoImportsLeft);
    }
    Ok(())
}

/// What one import did to a vault database.
#[derive(Debug, PartialEq, Eq)]
pub struct ImportDone {
    pub merged: ShareMerge,
    pub imports_left: u32,
    /// When the added items destroy themselves.
    pub expires_at: Option<u64>,
    /// The database changed (to be saved).
    pub changed: bool,
}

/// Imports the share database `share` (with its `policy`) into `db`, the vault. The rules are checked first (end
/// date, number of imports, clock). It is counted as an import only when a note was added: a file that is already
/// here, or whose items were destroyed here, changes nothing and costs nothing. `db` changes only when it succeeds.
pub fn import_into(db: &mut Db, share: &Db, policy: &SharePolicy, sys_now: u64) -> Result<ImportDone, String> {
    check_policy(policy, db.share_uses_of(&policy.share_id), sys_now, db.seen_ms).map_err(|p| p.message().to_string())?;
    let now = db.effective_now(sys_now);
    let expires_at = policy.item_life_ms.map(|l| now.saturating_add(l));
    let mut next = db.clone();
    let merged = next.merge_share(share, expires_at);
    if merged.added == 0 && merged.folders == 0 {
        let imports_left = policy.max_imports.saturating_sub(db.share_uses_of(&policy.share_id));
        return Ok(ImportDone { merged, imports_left, expires_at: None, changed: false });
    }
    if merged.added > 0 {
        next.note_share_use(&policy.share_id, now);
    }
    next.observe_time(now);
    let imports_left = policy.max_imports.saturating_sub(next.share_uses_of(&policy.share_id));
    *db = next;
    Ok(ImportDone { merged, imports_left, expires_at, changed: true })
}

/// Whether the file is deleted after this import: its rules ask for it, this import added something, and it was the
/// last one the file allows.
pub fn file_goes(merged: &ShareMerge, imports_left: u32, policy: &SharePolicy) -> bool {
    policy.delete_file && merged.added > 0 && imports_left == 0
}

/// One item of a share file, as the import prompt lists it (names and types only, never content).
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShareItem {
    /// The path inside the vault (`Work/bank.nqv`; a folder has no suffix).
    pub path: String,
    /// The type of note ("login", "ssh", "md", …); empty for a folder.
    pub ext: String,
    pub dir: bool,
    /// How many attachments it carries.
    pub attachments: u32,
}

/// The items of a share database, in path order (what the importer is shown before it agrees).
pub fn list_items(share: &Db) -> Vec<ShareItem> {
    let mut out: Vec<ShareItem> = share.entries.values().filter(|e| !e.deleted).map(|e| ShareItem {
        path: e.path.clone(), ext: e.ext.clone(), dir: e.dir, attachments: e.live_attachments().count() as u32,
    }).collect();
    out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()).then_with(|| a.path.cmp(&b.path)));
    out
}

/// What the import prompt shows once the file is open.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    /// What is in it, by name.
    pub items: Vec<ShareItem>,
    pub notes: u32,
    pub folders: u32,
    pub attachments: u32,
    pub valid_until: Option<u64>,
    pub item_life_ms: Option<u64>,
    pub delete_file: bool,
    /// "none" (no vault here yet), "locked" or "ready": a share only goes into a vault that exists and is open.
    pub vault: &'static str,
    /// Imports left (only known while the vault is open).
    pub imports_left: Option<u32>,
    /// Why it can't be imported now (`ShareProblem::code`); only checked while the vault is open.
    pub problem: Option<&'static str>,
}

/// What an import did.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShareImportResult {
    pub added: u32,
    pub already: u32,
    pub expired: u32,
    pub imports_left: u32,
    /// When the added items destroy themselves (Unix ms).
    pub expires_at: Option<u64>,
    /// The file was deleted, as its rules ask after the last import.
    pub file_deleted: bool,
    /// It should have been deleted but couldn't be.
    pub delete_failed: bool,
}

/// The counts of a share database (notes, folders, attachments).
fn counts(share: &Db) -> (u32, u32, u32) {
    let live = share.entries.values().filter(|e| !e.deleted);
    let (mut notes, mut folders, mut attachments) = (0, 0, 0);
    for e in live {
        if e.dir { folders += 1; } else { notes += 1; attachments += e.live_attachments().count() as u32; }
    }
    (notes, folders, attachments)
}

/// Whether the database of a share file can be imported: it must hold its rules, in range.
fn policy_of(share: &Db) -> Result<SharePolicy, String> {
    let policy = share.share.clone().ok_or("This is a backup, not a share file. Open it with Restore backup.")?;
    policy.validate(0)?; // the shape only: an end date is judged at import time
    Ok(policy)
}

/// Opens a share file with the password for it. A wrong password counts toward the unlock throttle.
async fn open_share_file(state: &VaultState, path: &str, password: String) -> Result<(Db, SharePolicy), String> {
    let data = std::fs::read(path).map_err(|e| format!("Couldn't read the file: {e}"))?;
    crate::vault_backup::parse_container(&data)?; // a clear message for a file that isn't one
    let password = Zeroizing::new(password);
    let share = guarded(state, move || {
        let p = crate::vault_backup::parse_container(&data).map_err(|_| vc::VaultError::BadMeta("share file"))?;
        let key = vc::unlock_with_password(&p.meta, &password)?;
        let id = p.meta.vault_id_bytes()?;
        vdb::Db::open(&key, &id, p.db_bytes).map_err(|_| vc::VaultError::Tampered)?.ok_or(vc::VaultError::BadMeta("database"))
    }).await?;
    let policy = policy_of(&share)?;
    Ok((share, policy))
}

/// Opens a share file and says what is in it and whether it can be imported now. Nothing is changed.
#[tauri::command]
pub async fn vault_share_inspect(app: AppHandle, state: State<'_, VaultState>, path: String, password: String) -> Result<ShareInfo, String> {
    let (share, policy) = open_share_file(&state, &path, password).await?;
    let (notes, folders, attachments) = counts(&share);
    let (vault, imports_left, problem) = if load_meta(&app)?.is_none() {
        ("none", None, None)
    } else if !state.is_unlocked() {
        ("locked", None, None)
    } else {
        let (uses, seen) = state.with_db(|db, _, _, _| Ok(((db.share_uses_of(&policy.share_id), db.seen_ms), false)))?;
        let left = policy.max_imports.saturating_sub(uses);
        ("ready", Some(left), check_policy(&policy, uses, vdb::now_ms(), seen).err().map(ShareProblem::code))
    };
    Ok(ShareInfo { items: list_items(&share), notes, folders, attachments, valid_until: policy.valid_until, item_life_ms: policy.item_life_ms, delete_file: policy.delete_file, vault, imports_left, problem })
}

/// Imports a share file into the unlocked vault (see `Db::merge_share`), counts the import, and deletes the file
/// when its rules say so after the last import (only once the import is saved).
#[tauri::command]
pub async fn vault_share_import(state: State<'_, VaultState>, path: String, password: String) -> Result<ShareImportResult, String> {
    if !state.is_unlocked() {
        return Err(ERR_LOCKED.into());
    }
    let (share, policy) = open_share_file(&state, &path, password).await?;
    let done = state.with_db(|db, _, _, _| {
        let done = import_into(db, &share, &policy, vdb::now_ms())?;
        let changed = done.changed;
        Ok((done, changed))
    })?;
    let (merged, imports_left, expires_at) = (done.merged, done.imports_left, done.expires_at);
    // Saved. Now the file, if it is to go: after the last import, and only a share file we just opened.
    let (mut file_deleted, mut delete_failed) = (false, false);
    if file_goes(&merged, imports_left, &policy) {
        match crate::vault_backup::check_dest(&path).and_then(|p| std::fs::remove_file(p).map_err(|e| e.to_string())) {
            Ok(()) => file_deleted = true,
            Err(_) => delete_failed = true,
        }
    }
    Ok(ShareImportResult { added: merged.added, already: merged.already, expired: merged.expired, imports_left, expires_at, file_deleted, delete_failed })
}

// ─── commands ────────────────────────────────────────────────────────────────

use tauri::{AppHandle, State};

use crate::vault::{guarded, load_meta, require_meta, VaultState, ERR_LOCKED};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareExportArgs {
    /// Paths of what to share (notes or folders).
    pub paths: Vec<String>,
    pub attachments: bool,
    /// Asked again before anything is released, like a backup.
    pub master_password: String,
    pub share_password: String,
    pub max_imports: u32,
    pub valid_until_ms: Option<u64>,
    pub item_life_hours: Option<u32>,
    pub delete_file: bool,
    pub dest_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareExportResult {
    pub bytes: u64,
    pub notes: u32,
}

/// What a selection holds, for the export prompt (needs the vault unlocked).
#[tauri::command]
pub fn vault_share_preview(state: State<'_, VaultState>, paths: Vec<String>, attachments: bool) -> Result<SharePreview, String> {
    state.with_db(|db, _, _, _| Ok((preview(db, &paths, attachments)?, false)))
}

/// Writes a share file of the chosen items to `dest_path` (`.nqb`).
#[tauri::command]
pub async fn vault_share_export(app: AppHandle, state: State<'_, VaultState>, args: ShareExportArgs) -> Result<ShareExportResult, String> {
    let dest = crate::vault_backup::check_dest(&args.dest_path)?;
    let now = vdb::now_ms();
    let policy = SharePolicy {
        share_id: vdb::new_id(),
        created_at: now,
        max_imports: args.max_imports,
        valid_until: args.valid_until_ms,
        item_life_ms: args.item_life_hours.map(|h| h as u64 * HOUR_MS),
        delete_file: args.delete_file,
    };
    policy.validate(now)?;
    let own = require_meta(&app)?;
    let master = Zeroizing::new(args.master_password);
    let share = Zeroizing::new(args.share_password);
    let m = own.clone();
    guarded(&state, move || vc::unlock_with_password(&m, &master).map(|_| ())).await?;
    let (meta, key) = tauri::async_runtime::spawn_blocking(move || make_share_key(&own, &share, KdfParams::default()))
        .await
        .map_err(|e| e.to_string())??;
    let (bytes, notes) = state.with_db(|db, _, _, _| {
        let notes = preview(db, &args.paths, args.attachments)?.notes;
        Ok(((make_share_container(db, &args.paths, args.attachments, policy.clone(), &meta, &key)?, notes), false))
    })?;
    // Never write a file we couldn't read back, with these rules.
    let parsed = crate::vault_backup::parse_container(&bytes)?;
    let back = crate::vault_backup::open_share(&parsed, &key)?;
    if back.share.as_ref() != Some(&policy) {
        return Err("The share file didn't come out right. Nothing was written.".into());
    }
    crate::vault::atomic_write(&dest, &bytes)?;
    Ok(ShareExportResult { bytes: bytes.len() as u64, notes })
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_backup::{build_container, build_container_of, parse_container, Kind};
    use crate::vault_core::create_vault;

    const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };
    const NOW: u64 = 1_800_000_000_000;

    fn policy() -> SharePolicy {
        SharePolicy { share_id: "0123456789abcdef0123456789abcdef".into(), created_at: NOW, max_imports: 2, valid_until: Some(NOW + 1000), item_life_ms: Some(7 * 24 * HOUR_MS), delete_file: true }
    }

    fn vault() -> Db {
        let mut db = Db::new();
        db.device = "dev".into();
        db.mkdir("Work").unwrap();
        db.put("Work/bank.nqv", "login", "bank secret").unwrap();
        db.put("Work/bank.nqv", "login", "bank secret v2").unwrap(); // history
        db.put("Work/mail.nqv", "login", "mail secret").unwrap();
        db.put("Personal/diary.nqv", "md", "my diary").unwrap();
        db.put("top.nqv", "md", "top").unwrap();
        db.set_tags("top.nqv", vec!["private".into()]).unwrap();
        db.set_starred("top.nqv", true).unwrap();
        db.put("gone.nqv", "md", "deleted").unwrap();
        db.trash("gone.nqv").unwrap();
        db
    }

    fn paths(p: &[&str]) -> Vec<String> {
        p.iter().map(|s| s.to_string()).collect()
    }

    fn rels(db: &Db) -> Vec<String> {
        let mut v: Vec<String> = db.entries.values().map(|e| e.path.clone()).collect();
        v.sort();
        v
    }

    #[test]
    fn the_rules_are_checked() {
        assert!(policy().validate(NOW).is_ok());
        let bad = |f: &dyn Fn(&mut SharePolicy)| { let mut p = policy(); f(&mut p); p.validate(NOW).is_err() };
        assert!(bad(&|p| p.share_id = "short".into()));
        assert!(bad(&|p| p.share_id = "z".repeat(32)));
        assert!(bad(&|p| p.max_imports = 0));
        assert!(bad(&|p| p.max_imports = MAX_IMPORTS_LIMIT + 1));
        assert!(bad(&|p| p.valid_until = Some(NOW)), "an end that has passed");
        assert!(bad(&|p| p.item_life_ms = Some(HOUR_MS - 1)));
        assert!(bad(&|p| p.item_life_ms = Some(HOUR_MS + 1)), "whole hours only");
        assert!(bad(&|p| p.item_life_ms = Some((MAX_ITEM_LIFE_HOURS as u64 + 1) * HOUR_MS)));
        let mut p = policy();
        p.valid_until = None;
        p.item_life_ms = None;
        p.max_imports = MAX_IMPORTS_LIMIT;
        assert!(p.validate(NOW).is_ok(), "no end and items that stay are allowed");
    }

    #[test]
    fn a_folder_takes_what_is_in_it_and_a_note_keeps_its_folder() {
        let db = vault();
        let one = build_share_db(&db, &paths(&["Work/bank.nqv"]), false, policy()).unwrap();
        assert_eq!(rels(&one), ["Work", "Work/bank.nqv"], "the note and the folder above it, nothing else");
        let folder = build_share_db(&db, &paths(&["Work"]), false, policy()).unwrap();
        assert_eq!(rels(&folder), ["Work", "Work/bank.nqv", "Work/mail.nqv"]);
        let implied = build_share_db(&db, &paths(&["Personal"]), false, policy()).unwrap();
        assert_eq!(rels(&implied), ["Personal/diary.nqv"], "a folder that only exists through its notes");
        let two = build_share_db(&db, &paths(&["top.nqv", "Work/mail.nqv", "top.nqv"]), false, policy()).unwrap();
        assert_eq!(rels(&two), ["Work", "Work/mail.nqv", "top.nqv"], "a repeated path is taken once");
    }

    #[test]
    fn bad_selections_are_refused() {
        let db = vault();
        assert!(build_share_db(&db, &[], false, policy()).is_err(), "nothing chosen");
        assert!(build_share_db(&db, &paths(&[""]), false, policy()).is_err());
        assert!(build_share_db(&db, &paths(&["nope.nqv"]), false, policy()).is_err());
        assert!(build_share_db(&db, &paths(&["gone.nqv"]), false, policy()).is_err(), "the recycle bin is not shared");
        assert!(build_share_db(&db, &paths(&["Work/"]), false, policy()).is_ok(), "a trailing slash is fine");
        let mut empty = Db::new();
        empty.device = "dev".into();
        empty.mkdir("Empty").unwrap();
        assert!(build_share_db(&empty, &paths(&["Empty"]), false, policy()).is_err(), "a folder with no notes");
    }

    #[test]
    fn a_share_holds_only_what_was_chosen_under_new_ids() {
        let db = vault();
        let share = build_share_db(&db, &paths(&["Work/bank.nqv", "top.nqv"]), false, policy()).unwrap();
        let bank = share.entries.values().find(|e| e.path == "Work/bank.nqv").unwrap();
        assert_eq!((bank.ext.as_str(), bank.content.as_str()), ("login", "bank secret v2"));
        assert!(bank.history.is_empty(), "old versions can hold old passwords");
        let top = share.entries.values().find(|e| e.path == "top.nqv").unwrap();
        assert!(top.tags.is_empty() && !top.starred, "tags and stars stay with the sender");
        assert!(share.entries.values().all(|e| e.trashed_at.is_none() && !e.deleted && e.expires_at.is_none()));
        let src_ids: std::collections::BTreeSet<&String> = db.entries.keys().collect();
        assert!(share.entries.keys().all(|id| !src_ids.contains(id)), "none of the sender's ids");
        assert_eq!(share.share, Some(policy()));
        // A second export of the same selection gets other ids again.
        let again = build_share_db(&db, &paths(&["Work/bank.nqv", "top.nqv"]), false, policy()).unwrap();
        assert!(again.entries.keys().all(|id| !share.entries.contains_key(id)));
    }

    #[test]
    fn attachments_go_only_when_asked_for_and_under_new_ids() {
        let mut db = vault();
        let data = vdb::b64_encode(b"hello");
        db.attach_add("top.nqv", "a.txt", &data).unwrap();
        db.attach_add("top.nqv", "b.txt", &data).unwrap();
        let id = db.attach_list("top.nqv").unwrap()[0].id.clone();
        db.attach_remove("top.nqv", &id).unwrap(); // a removed one never goes
        let without = build_share_db(&db, &paths(&["top.nqv"]), false, policy()).unwrap();
        assert!(without.entries.values().all(|e| e.attachments.is_empty()));
        let with = build_share_db(&db, &paths(&["top.nqv"]), true, policy()).unwrap();
        let top = with.entries.values().find(|e| e.path == "top.nqv").unwrap();
        assert_eq!(top.attachments.len(), 1);
        assert_eq!((top.attachments[0].name.as_str(), top.attachments[0].data.as_str()), ("b.txt", data.as_str()));
        let src = db.entries.values().find(|e| e.path == "top.nqv").unwrap();
        assert!(src.attachments.iter().all(|a| a.id != top.attachments[0].id), "a new attachment id");
        let p = preview(&db, &paths(&["top.nqv", "Work"]), true).unwrap();
        assert_eq!((p.notes, p.folders, p.attachments, p.attachment_bytes), (3, 1, 1, 5));
        assert_eq!(preview(&db, &paths(&["top.nqv"]), false).unwrap().attachments, 0);
    }

    #[test]
    fn a_share_file_opens_with_its_password_and_only_with_it() {
        let db = vault();
        let (own, _, _) = create_vault("the master password", FAST).unwrap();
        let (meta, key) = make_share_key(&own, "a password for sharing", FAST).unwrap();
        let file = make_share_container(&db, &paths(&["Work"]), false, policy(), &meta, &key).unwrap();
        let p = parse_container(&file).unwrap();
        assert_eq!(p.kind, Kind::Share);
        let id = p.meta.vault_id_bytes().unwrap();
        // The key from the share password opens it, with the rules and the items.
        let k = vc::unlock_with_password(&p.meta, "a password for sharing").unwrap();
        let back = vdb::Db::open(&k, &id, p.db_bytes).unwrap().unwrap();
        assert_eq!(back.share, Some(policy()));
        assert_eq!(rels(&back), ["Work", "Work/bank.nqv", "Work/mail.nqv"]);
        // The master password and a wrong one don't.
        assert!(vc::unlock_with_password(&p.meta, "the master password").is_err());
        assert!(vc::unlock_with_password(&p.meta, "another one entirely").is_err());
        // Nothing in the file is readable without the key.
        let text = String::from_utf8_lossy(&file);
        assert!(!text.contains("bank secret") && !text.contains("max_imports"));
    }

    #[test]
    fn a_changed_byte_stops_the_file_opening() {
        let db = vault();
        let (own, _, _) = create_vault("the master password", FAST).unwrap();
        let (meta, key) = make_share_key(&own, "a password for sharing", FAST).unwrap();
        let file = make_share_container(&db, &paths(&["Work"]), false, policy(), &meta, &key).unwrap();
        let p = parse_container(&file).unwrap();
        let id = p.meta.vault_id_bytes().unwrap();
        let mut sealed = p.db_bytes.to_vec();
        let i = sealed.len() / 2;
        sealed[i] ^= 1;
        // Even with the checksum made right again, the seal catches it.
        let forged = build_container_of(Kind::Share, p.meta_bytes, &sealed);
        let q = parse_container(&forged).unwrap();
        assert!(vdb::Db::open(&key, &id, q.db_bytes).is_err(), "rules can't be edited");
    }

    #[test]
    fn the_share_password_must_differ_from_the_master_password_and_not_be_weak() {
        let (own, _, _) = create_vault("the master password", FAST).unwrap();
        assert!(make_share_key(&own, "the master password", FAST).is_err());
        assert!(make_share_key(&own, "short", FAST).is_err());
        assert!(make_share_key(&own, "a different password", FAST).is_ok());
    }

    #[test]
    fn a_share_file_is_never_taken_for_a_backup() {
        let db = vault();
        let (own, _, _) = create_vault("the master password", FAST).unwrap();
        let (meta, key) = make_share_key(&own, "a password for sharing", FAST).unwrap();
        let file = make_share_container(&db, &paths(&["top.nqv"]), false, policy(), &meta, &key).unwrap();
        // A backup file keeps its old magic and kind.
        let id = meta.vault_id_bytes().unwrap();
        let sealed = db.seal(&key, &id).unwrap();
        assert_eq!(parse_container(&build_container(meta.to_json().as_bytes(), &sealed)).unwrap().kind, Kind::Backup);
        assert_eq!(&file[..4], b"NQB2", "an older Notiq doesn't recognise it at all");
    }

    // ─── importing ───────────────────────────────────────────────────────────

    const WEEK: u64 = 7 * 24 * HOUR_MS;

    fn receiver() -> Db {
        let mut db = Db::new();
        db.device = "recv".into();
        db.put("mine.nqv", "md", "my own note").unwrap();
        db
    }

    /// The database of a share of `Work` (two notes and their folder) with `max` imports allowed.
    fn share_of_work(max: u32) -> (Db, SharePolicy) {
        let mut p = policy();
        p.max_imports = max;
        p.valid_until = Some(NOW + 10 * WEEK);
        let db = build_share_db(&vault(), &paths(&["Work"]), false, p.clone()).unwrap();
        (db, p)
    }

    fn by_path<'a>(db: &'a Db, path: &str) -> &'a Entry {
        db.entries.values().find(|e| e.path == path).unwrap_or_else(|| panic!("no entry at {path}"))
    }

    #[test]
    fn an_import_adds_the_items_with_their_end_of_life_and_counts_once() {
        let (share, p) = share_of_work(2);
        let mut db = receiver();
        let done = import_into(&mut db, &share, &p, NOW).unwrap();
        assert_eq!((done.merged.added, done.merged.folders, done.merged.already), (2, 1, 0));
        assert_eq!((done.imports_left, done.changed, done.expires_at), (1, true, Some(NOW + WEEK)));
        for path in ["Work", "Work/bank.nqv", "Work/mail.nqv"] {
            assert_eq!(by_path(&db, path).expires_at, Some(NOW + WEEK), "{path} gets its end of life from the import time");
        }
        assert_eq!(by_path(&db, "Work/bank.nqv").content, "bank secret v2");
        assert_eq!(by_path(&db, "mine.nqv").expires_at, None, "what was here is not touched");
        assert_eq!(db.share_uses_of(&p.share_id), 1);
        assert!(db.seen_ms >= NOW);
        assert!(db.share.is_none(), "the rules never become part of the vault");
    }

    #[test]
    fn the_same_file_again_adds_nothing_and_costs_nothing() {
        let (share, p) = share_of_work(2);
        let mut db = receiver();
        import_into(&mut db, &share, &p, NOW).unwrap();
        let again = import_into(&mut db, &share, &p, NOW + 1000).unwrap();
        assert_eq!((again.merged.added, again.merged.already, again.changed), (0, 2, false));
        assert_eq!((again.imports_left, again.expires_at), (1, None));
        assert_eq!(db.share_uses_of(&p.share_id), 1, "not counted");
        assert_eq!(by_path(&db, "Work/bank.nqv").expires_at, Some(NOW + WEEK), "the clock is not restarted");
    }

    #[test]
    fn import_delete_import_is_stopped_by_the_count_and_allowed_while_it_lasts() {
        let (share, p) = share_of_work(1);
        let mut db = receiver();
        import_into(&mut db, &share, &p, NOW).unwrap();
        for path in ["Work/bank.nqv", "Work/mail.nqv"] { db.trash(path).unwrap(); db.purge(path).unwrap(); }
        let err = import_into(&mut db, &share, &p, NOW + 1).unwrap_err();
        assert_eq!(err, ShareProblem::NoImportsLeft.message());
        assert!(by_path(&db, "Work/bank.nqv").deleted, "nothing came back");

        // With two imports allowed the second one brings the deleted notes back, and then it is used up.
        let (share, p) = share_of_work(2);
        let mut db = receiver();
        import_into(&mut db, &share, &p, NOW).unwrap();
        for path in ["Work/bank.nqv", "Work/mail.nqv"] { db.trash(path).unwrap(); db.purge(path).unwrap(); }
        let second = import_into(&mut db, &share, &p, NOW + 1).unwrap();
        assert_eq!((second.merged.added, second.imports_left), (2, 0));
        assert_eq!(by_path(&db, "Work/bank.nqv").content, "bank secret v2");
        assert!(import_into(&mut db, &share, &p, NOW + 2).is_err(), "a third time is over the limit");
    }

    #[test]
    fn an_expired_item_never_returns_by_importing_again() {
        let (share, p) = share_of_work(3);
        let mut db = receiver();
        import_into(&mut db, &share, &p, NOW).unwrap();
        assert_eq!(db.sweep_expired(NOW + WEEK + 1).len(), 3, "the notes and their folder are destroyed");
        let again = import_into(&mut db, &share, &p, NOW + WEEK + 2).unwrap();
        assert_eq!((again.merged.added, again.merged.expired, again.changed), (0, 2, false));
        assert_eq!(db.share_uses_of(&p.share_id), 1);
        assert!(by_path(&db, "Work/bank.nqv").deleted);
    }

    #[test]
    fn the_rules_are_enforced_at_import() {
        let (share, mut p) = share_of_work(2);
        let mut db = receiver();
        // The file ended.
        p.valid_until = Some(NOW);
        assert_eq!(import_into(&mut db, &share, &p, NOW).unwrap_err(), ShareProblem::Expired.message());
        assert_eq!(import_into(&mut db, &share, &p, NOW + 5).unwrap_err(), ShareProblem::Expired.message());
        assert!(db.entries.len() == 1, "a refused import changes nothing");
        // The clock is behind what this vault has seen.
        let (share, p) = share_of_work(2);
        let mut seen = receiver();
        seen.observe_time(NOW + 3 * HOUR_MS);
        assert_eq!(import_into(&mut seen, &share, &p, NOW).unwrap_err(), ShareProblem::ClockBehind.message());
        // A clock set back by a little is a drift, not an attack: the vault's time is used.
        let mut drift = receiver();
        drift.observe_time(NOW + 5 * 60_000);
        let done = import_into(&mut drift, &share, &p, NOW).unwrap();
        assert_eq!(done.expires_at, Some(NOW + 5 * 60_000 + WEEK), "judged by the latest time seen, not the clock");
    }

    #[test]
    fn setting_the_clock_back_gains_nothing() {
        let (share, mut p) = share_of_work(2);
        p.valid_until = Some(NOW + 1_000_000);
        let mut db = receiver();
        db.observe_time(NOW + 1_000_000 + 60_000); // seen after the end, a minute ahead of the clock now
        assert_eq!(check_policy(&p, 0, NOW + 1_000_000 - 1, db.seen_ms), Err(ShareProblem::Expired), "judged by what was seen");
        assert!(import_into(&mut db, &share, &p, NOW + 1_000_000 - 1).is_err());
        // Items too: destroyed by the time the vault has seen, whatever the clock says.
        let (share, p) = share_of_work(2);
        let mut db = receiver();
        import_into(&mut db, &share, &p, NOW).unwrap();
        db.observe_time(NOW + WEEK + 5);
        assert_eq!(db.sweep_expired(NOW + 10).len(), 3, "the clock says it is early; the vault has seen it is late");
    }

    #[test]
    fn names_that_clash_and_folders_that_exist() {
        let (share, p) = share_of_work(2);
        let mut db = receiver();
        db.mkdir("Work").unwrap(); // the receiver's own folder
        db.put("Work/bank.nqv", "md", "the receiver's own bank note").unwrap();
        let done = import_into(&mut db, &share, &p, NOW).unwrap();
        assert_eq!((done.merged.added, done.merged.folders), (2, 0), "the folder is the same one");
        assert_eq!(by_path(&db, "Work/bank.nqv").content, "the receiver's own bank note");
        assert_eq!(by_path(&db, "Work/bank (from share).nqv").content, "bank secret v2");
        assert_eq!(by_path(&db, "Work/bank (from share).nqv").expires_at, Some(NOW + WEEK));
        assert_eq!(by_path(&db, "Work/bank.nqv").expires_at, None);
        // Destroying the imported items leaves the receiver's folder and note alone.
        db.sweep_expired(NOW + WEEK + 1);
        assert_eq!(by_path(&db, "Work/bank.nqv").content, "the receiver's own bank note");
        assert!(!by_path(&db, "Work").deleted);
    }

    #[test]
    fn items_that_came_from_a_share_can_not_be_shared_again() {
        let (share, p) = share_of_work(2);
        let mut db = receiver();
        import_into(&mut db, &share, &p, NOW).unwrap();
        let err = build_share_db(&db, &paths(&["Work/bank.nqv"]), false, policy()).unwrap_err();
        assert!(err.contains("came from a share") && err.starts_with("1 of the chosen note"), "{err}");
        assert!(build_share_db(&db, &paths(&["Work"]), false, policy()).unwrap_err().starts_with("2 of the chosen notes"), "a folder takes what is in it");
        assert!(preview(&db, &paths(&["Work"]), false).is_err());
        assert!(build_share_db(&db, &paths(&["mine.nqv"]), false, policy()).is_ok(), "the receiver's own notes can be shared");
    }

    #[test]
    fn the_file_goes_only_after_the_last_import_that_added_something() {
        let (_, mut p) = share_of_work(2);
        let added = ShareMerge { added: 1, ..Default::default() };
        let nothing = ShareMerge::default();
        assert!(file_goes(&added, 0, &p));
        assert!(!file_goes(&added, 1, &p), "more imports are allowed");
        assert!(!file_goes(&nothing, 0, &p), "an import that added nothing deletes nothing");
        p.delete_file = false;
        assert!(!file_goes(&added, 0, &p), "the sender didn't ask for it");
    }

    #[test]
    fn the_counts_and_the_latest_time_merge_as_the_larger_one() {
        let (share, p) = share_of_work(5);
        let (mut a, mut b) = (receiver(), receiver());
        import_into(&mut a, &share, &p, NOW).unwrap();
        import_into(&mut b, &share, &p, NOW + 5).unwrap();
        import_into(&mut b, &share, &p, NOW + 6).ok();
        b.note_share_use(&p.share_id, NOW + 9); // b counted a second import
        for (x, y) in [(&a, &b), (&b, &a)] {
            let m = crate::vault_merge::merge(x, y);
            assert_eq!(m.share_uses_of(&p.share_id), 2, "the larger count, never the sum");
            assert_eq!(m.share_uses[&p.share_id].last_at, NOW + 9);
            assert_eq!(m.seen_ms, a.seen_ms.max(b.seen_ms));
        }
        let m = crate::vault_merge::merge(&a, &a);
        assert_eq!(m.share_uses, a.share_uses);
    }

    #[test]
    fn the_count_and_the_time_survive_saving_and_opening() {
        let (share, p) = share_of_work(2);
        let (meta, key, _) = create_vault("a-long-test-password-1", FAST).unwrap();
        let id = meta.vault_id_bytes().unwrap();
        let mut db = receiver();
        import_into(&mut db, &share, &p, NOW).unwrap();
        let back = vdb::Db::open(&key, &id, &db.seal(&key, &id).unwrap()).unwrap().unwrap();
        assert_eq!(back.share_uses_of(&p.share_id), 1);
        assert_eq!(back.seen_ms, db.seen_ms);
        assert_eq!(back.seen_saved, back.seen_ms, "what was just opened is what is on disk");
        assert!(!back.seen_needs_save());
        let mut later = back.clone();
        later.observe_time(back.seen_ms + vdb::SEEN_SAVE_EVERY_MS + 1);
        assert!(later.seen_needs_save() && !back.seen_needs_save());
    }

    #[test]
    fn a_whole_file_goes_through_the_same_steps_as_the_command() {
        let sender = vault();
        let (own, _, _) = create_vault("the master password", FAST).unwrap();
        let (meta, key) = make_share_key(&own, "a password for sharing", FAST).unwrap();
        let mut p = policy();
        p.valid_until = Some(NOW + 10 * WEEK);
        let file = make_share_container(&sender, &paths(&["Work/bank.nqv"]), false, p.clone(), &meta, &key).unwrap();
        // What `open_share_file` does.
        let parsed = parse_container(&file).unwrap();
        let k = vc::unlock_with_password(&parsed.meta, "a password for sharing").unwrap();
        let share = vdb::Db::open(&k, &parsed.meta.vault_id_bytes().unwrap(), parsed.db_bytes).unwrap().unwrap();
        let policy = policy_of(&share).unwrap();
        assert_eq!(counts(&share), (1, 1, 0));
        let mut db = receiver();
        let done = import_into(&mut db, &share, &policy, NOW).unwrap();
        assert_eq!((done.merged.added, done.imports_left), (1, 1));
        assert_eq!(by_path(&db, "Work/bank.nqv").content, "bank secret v2");
        // A backup with no rules inside is not a share.
        assert!(policy_of(&vdb::Db::new()).unwrap_err().contains("backup"));
        // Rules out of range are refused even though the file opened.
        let mut bad = share.clone();
        bad.share.as_mut().unwrap().max_imports = 0;
        assert!(policy_of(&bad).is_err());
    }

    #[test]
    fn the_import_prompt_lists_what_is_in_a_share_by_name_in_path_order() {
        let mut p = policy();
        p.valid_until = None;
        let mut src = vault();
        src.attach_add("Work/mail.nqv", "a.txt", &vdb::b64_encode(b"x")).unwrap();
        let share = build_share_db(&src, &paths(&["Work", "top.nqv"]), true, p).unwrap();
        let list = list_items(&share);
        let shown: Vec<(&str, &str, bool, u32)> = list.iter().map(|i| (i.path.as_str(), i.ext.as_str(), i.dir, i.attachments)).collect();
        assert_eq!(shown, vec![
            ("top.nqv", "md", false, 0),
            ("Work", "", true, 0),
            ("Work/bank.nqv", "login", false, 0),
            ("Work/mail.nqv", "login", false, 1),
        ]);
        // Names and types only: no content anywhere in what the prompt gets.
        let json = serde_json::to_string(&list).unwrap();
        assert!(!json.contains("bank secret") && !json.contains("mail secret"));
        assert!(json.contains("\"attachments\":1"));
    }
}
