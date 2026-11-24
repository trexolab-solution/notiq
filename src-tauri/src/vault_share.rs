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
use crate::vault_db::{self as vdb, Db, Entry};

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

// ─── commands ────────────────────────────────────────────────────────────────

use tauri::{AppHandle, State};

use crate::vault::{guarded, require_meta, VaultState};

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
}
