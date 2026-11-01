//! Backup export / restore of the local-only vault.
//!
//! Container (`.nqbackup`): magic `NQB1`, u32 BE length + `vault.json` bytes, the raw
//! `vault.nqdb` bytes (still encrypted, never decrypted here), then a CRC-32 (u32 BE)
//! of everything before it so truncation / corruption is detected.
//!
//! A backup is restored either by **replacing** this device's vault with the backup's files
//! ([`install`]), or by **merging** it into the unlocked vault ([`merge_into_vault`]): the backup is
//! opened with its own master password and its entries are re-sealed into the current vault with
//! the current key; this vault's password, key file and id never change.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::vault::{atomic_write, guarded, load_meta, meta_path, require_meta, VaultState, ERR_LOCKED};
use crate::vault_core::{self as vc, VaultKey, VaultMeta, VAULT_ID_LEN};
use crate::vault_db as vdb;

const MAGIC: &[u8; 4] = b"NQB1";
const EXT: &str = "nqbackup";
const MAX_META: usize = 64 * 1024;
/// magic + meta length + crc
const MIN_LEN: usize = 4 + 4 + 4;

#[derive(Serialize)]
pub struct ExportResult {
    bytes: u64,
    entries_hint: Option<u32>,
}

#[derive(Serialize)]
pub struct InspectResult {
    ok: bool,
    vault_id_hex: String,
    db_bytes: u64,
    /// File modification time (unix seconds).
    created: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct MergeResult {
    #[serde(flatten)]
    counts: vdb::BackupMerge,
    /// Where the vault.json / vault.nqdb from before the merge were copied (only when it changed).
    previous_saved_to: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct ImportResult {
    vault_id_hex: String,
    db_bytes: u64,
    replaced: bool,
    /// Where the previous vault.json / vault.nqdb were copied (only when something was replaced).
    previous_saved_to: Option<String>,
}

// ─── container ───────────────────────────────────────────────────────────────

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

pub(crate) fn build_container(meta: &[u8], db: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(MIN_LEN + meta.len() + db.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(meta);
    out.extend_from_slice(db);
    let crc = crc32(&out);
    out.extend_from_slice(&crc.to_be_bytes());
    out
}

pub(crate) struct Parsed<'a> {
    meta_bytes: &'a [u8],
    db_bytes: &'a [u8],
    meta: VaultMeta,
}

pub(crate) fn parse_container(data: &[u8]) -> Result<Parsed<'_>, String> {
    const BAD: &str = "This isn't a valid Notiq backup file";
    if data.len() < MIN_LEN || &data[..4] != MAGIC {
        return Err(BAD.into());
    }
    let (body, tail) = data.split_at(data.len() - 4);
    if crc32(body) != u32::from_be_bytes(tail.try_into().unwrap()) {
        return Err("The backup file is damaged or incomplete (checksum mismatch)".into());
    }
    let meta_len = u32::from_be_bytes(body[4..8].try_into().unwrap()) as usize;
    if meta_len == 0 || meta_len > MAX_META || 8 + meta_len > body.len() {
        return Err(BAD.into());
    }
    let meta_bytes = &body[8..8 + meta_len];
    let db_bytes = &body[8 + meta_len..];
    let meta = std::str::from_utf8(meta_bytes)
        .map_err(|_| BAD.to_string())
        .and_then(|s| VaultMeta::from_json(s).map_err(|e| format!("The backup's key file is invalid: {e}")))?;
    let id = meta.vault_id_bytes().map_err(|e| e.to_string())?;
    let min_db = 4 + 1 + VAULT_ID_LEN + 1 + vc::NONCE_LEN + 16;
    if db_bytes.len() < min_db || &db_bytes[..4] != vc::MAGIC {
        return Err("The backup's vault database is invalid".into());
    }
    if db_bytes[4] != vc::FORMAT_VERSION {
        return Err("The backup was made by a newer version of Notiq".into());
    }
    if db_bytes[5..5 + VAULT_ID_LEN] != id {
        return Err("The backup is inconsistent: its database belongs to a different vault".into());
    }
    Ok(Parsed { meta_bytes, db_bytes, meta })
}

fn check_dest(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    let ok = p.is_absolute()
        && p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case(EXT)).unwrap_or(false);
    if !ok {
        return Err("Backups must be saved as an absolute path ending in .nqbackup".into());
    }
    Ok(p)
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ─── install (pure, testable) ────────────────────────────────────────────────

/// Copies the vault's `meta_file` / `db_file` (those that exist) into `<data_dir>/<prefix>-<ts>/`.
fn keep_copy(data_dir: &Path, prefix: &str, ts: u64, meta_file: &Path, db_file: &Path) -> Result<String, String> {
    let dir = data_dir.join(format!("{prefix}-{ts}"));
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for f in [meta_file, db_file] {
        if f.exists() {
            let name = f.file_name().expect("file name");
            fs::copy(f, dir.join(name)).map_err(|e| format!("Couldn't keep a copy of the current vault: {e}"))?;
        }
    }
    Ok(dir.to_string_lossy().into_owned())
}

/// Opens the backup's database with `key`, derived from the backup's own master password (see
/// [`backup_key`]). Errors when the key doesn't open it.
fn open_backup(p: &Parsed<'_>, key: &VaultKey) -> Result<vdb::Db, String> {
    let id = p.meta.vault_id_bytes().map_err(|e| e.to_string())?;
    vdb::Db::open(key, &id, p.db_bytes)
        .map_err(|_| "The backup couldn't be opened with that password".to_string())?
        .ok_or_else(|| "The backup's vault database is invalid".to_string())
}

/// The backup's key from its master password (Argon2: run it off the main thread).
pub(crate) fn backup_key(data: &[u8], password: &str) -> Result<VaultKey, vc::VaultError> {
    let p = parse_container(data).map_err(|_| vc::VaultError::BadMeta("backup"))?;
    vc::unlock_with_password(&p.meta, password)
}

/// Merges the backup `data` (opened with its `backup_key`) into the unlocked vault in `state`
/// (see [`vdb::Db::merge_backup`]). Before the merged database is written (atomically, by
/// `with_db`), the current vault.json / vault.nqdb are copied into `<data_dir>/before-merge-<ts>/`.
/// Nothing is written when the backup can't be opened or adds nothing. The merge is a local
/// change, so the next sync uploads it.
pub(crate) fn merge_into_vault(state: &VaultState, data_dir: &Path, meta_file: &Path, data: &[u8], backup_key: &VaultKey, ts: u64) -> Result<MergeResult, String> {
    let p = parse_container(data)?;
    let backup = open_backup(&p, backup_key)?;
    state.with_db(|db, root, _, _| {
        let mut next = db.clone();
        let counts = next.merge_backup(&backup);
        if !counts.changed { return Ok((MergeResult { counts, previous_saved_to: None }, false)); }
        let saved = keep_copy(data_dir, "before-merge", ts, meta_file, &vdb::db_path(root))?;
        *db = next;
        Ok((MergeResult { counts, previous_saved_to: Some(saved) }, true))
    })
}

/// Writes the backup's files into `meta_file` / `db_file`. An existing vault is refused unless
/// `replace`; then its files are first copied into `<data_dir>/before-restore-<ts>/`.
pub(crate) fn install(data_dir: &Path, meta_file: &Path, db_file: &Path, data: &[u8], replace: bool, ts: u64) -> Result<ImportResult, String> {
    let p = parse_container(data)?;
    let exists = meta_file.exists();
    if exists && !replace {
        return Err("A vault already exists on this device. Restoring would replace it.".into());
    }
    let saved = if exists || db_file.exists() { Some(keep_copy(data_dir, "before-restore", ts, meta_file, db_file)?) } else { None };
    // The marker first: a restored database must never sync without being re-stamped (on the
    // first load after unlock, see vault_db::Db::restamp_restored).
    let marker = vdb::restored_marker_path(db_file.parent().ok_or("Invalid vault folder")?);
    atomic_write(&marker, p.meta.vault_id.as_bytes())?;
    atomic_write(db_file, p.db_bytes)?;
    atomic_write(meta_file, p.meta_bytes)?;
    Ok(ImportResult {
        vault_id_hex: p.meta.vault_id.clone(),
        db_bytes: p.db_bytes.len() as u64,
        replaced: exists,
        previous_saved_to: saved,
    })
}

// ─── commands ────────────────────────────────────────────────────────────────

/// Re-checks the master password (counts toward the unlock throttle). Used before export.
#[tauri::command]
pub async fn vault_verify_password(app: AppHandle, state: State<'_, VaultState>, password: String) -> Result<(), String> {
    let meta = require_meta(&app)?;
    let password = Zeroizing::new(password);
    guarded(&state, move || vc::unlock_with_password(&meta, &password).map(|_| ())).await
}

/// Writes `<dest_path>` (.nqbackup). Needs the vault unlocked so the file on disk is current.
#[tauri::command]
pub fn vault_backup_export(app: AppHandle, state: State<'_, VaultState>, dest_path: String) -> Result<ExportResult, String> {
    let dest = check_dest(&dest_path)?;
    // Loads (and, if it was never written, creates) vault.nqdb; errors VAULT_LOCKED when locked.
    let (root, entries) = state.with_db(|db, root, _, _| {
        Ok(((root.to_path_buf(), db.list().len() as u32), !vdb::db_path(root).exists()))
    })?;
    let meta = fs::read(meta_path(&app)?).map_err(|e| e.to_string())?;
    let db = fs::read(vdb::db_path(&root)).map_err(|e| e.to_string())?;
    let out = build_container(&meta, &db);
    parse_container(&out)?; // never write a container we couldn't read back
    atomic_write(&dest, &out)?;
    Ok(ExportResult { bytes: out.len() as u64, entries_hint: Some(entries) })
}

/// Header-only validation; never needs the password.
#[tauri::command]
pub fn vault_backup_inspect(path: String) -> Result<InspectResult, String> {
    let data = fs::read(&path).map_err(|e| format!("Couldn't read the file: {e}"))?;
    let p = parse_container(&data)?;
    let created = fs::metadata(&path).and_then(|m| m.modified()).ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs());
    Ok(InspectResult { ok: true, vault_id_hex: p.meta.vault_id.clone(), db_bytes: p.db_bytes.len() as u64, created })
}

/// Merges a backup into the unlocked vault on this device, opening it with `password` (the
/// backup's master password, which may differ from this vault's). Counts toward the unlock
/// throttle like any password check. Errors `VAULT_LOCKED` when the vault is locked.
#[tauri::command]
pub async fn vault_backup_merge(app: AppHandle, state: State<'_, VaultState>, path: String, password: String) -> Result<MergeResult, String> {
    let data = fs::read(&path).map_err(|e| format!("Couldn't read the file: {e}"))?;
    parse_container(&data)?;
    if !state.is_unlocked() { return Err(ERR_LOCKED.into()); }
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_file = meta_path(&app)?;
    let password = Zeroizing::new(password);
    let (data, key) = guarded(&state, move || { let k = backup_key(&data, &password)?; Ok((data, k)) }).await?;
    merge_into_vault(&state, &data_dir, &meta_file, &data, &key, now_secs())
}

/// Installs a backup. Refuses when a vault exists unless `replace`. The in-memory vault is locked.
#[tauri::command]
pub fn vault_backup_import(app: AppHandle, state: State<'_, VaultState>, path: String, replace: bool) -> Result<ImportResult, String> {
    let data = fs::read(&path).map_err(|e| format!("Couldn't read the file: {e}"))?;
    let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let meta_file = meta_path(&app)?;
    let exists = load_meta(&app).map(|m| m.is_some()).unwrap_or(meta_file.exists());
    if exists && !replace {
        return Err("A vault already exists on this device. Restoring would replace it.".into());
    }
    parse_container(&data)?; // validate before touching anything in memory
    let root = state.root().unwrap_or_else(|| data_dir.clone());
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    state.lock_all();
    let out = install(&data_dir, &meta_file, &vdb::db_path(&root), &data, replace, now_secs())?;
    crate::hello::invalidate(&app); // 0.7.0 hello: a restored vault always needs the master password first
    Ok(out)
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault_core::{create_vault, KdfParams};

    const FAST: KdfParams = KdfParams { m_kib: 64, t: 1, p: 1 };

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nq-backup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A real vault: (vault.json bytes, sealed db bytes, meta)
    fn make_vault(content: &str) -> (Vec<u8>, Vec<u8>, VaultMeta) {
        let (meta, key, _) = create_vault("a-long-test-password-1", FAST).unwrap();
        let id = meta.vault_id_bytes().unwrap();
        let mut db = vdb::Db::new();
        db.put("a.nqv", "md", content).unwrap();
        (meta.to_json().into_bytes(), db.seal(&key, &id).unwrap(), meta)
    }

    #[test]
    fn round_trip_into_a_fresh_device() {
        let (m, d, meta) = make_vault("secret");
        let c = build_container(&m, &d);
        let dir = tmp("rt");
        let (mf, df) = (dir.join("vault.json"), dir.join("sub").join("vault.nqdb"));
        let r = install(&dir, &mf, &df, &c, false, 1).unwrap();
        assert!(!r.replaced && r.previous_saved_to.is_none());
        assert_eq!(r.vault_id_hex, meta.vault_id);
        assert_eq!(fs::read(&mf).unwrap(), m);
        assert_eq!(fs::read(&df).unwrap(), d);
        assert!(vdb::restored_marker_path(df.parent().unwrap()).exists(), "the first load re-stamps it");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupted_or_truncated_is_rejected() {
        let (m, d, _) = make_vault("x");
        let c = build_container(&m, &d);
        assert!(parse_container(&c).is_ok());
        let mut flipped = c.clone();
        let i = flipped.len() / 2;
        flipped[i] ^= 1;
        assert!(parse_container(&flipped).is_err());
        assert!(parse_container(&c[..c.len() - 5]).is_err());
        assert!(parse_container(&c[..6]).is_err());
        assert!(parse_container(b"").is_err());
        let mut bad_magic = c.clone();
        bad_magic[0] = b'X';
        assert!(parse_container(&bad_magic).is_err());
    }

    #[test]
    fn vault_id_mismatch_is_rejected() {
        let (m, _, _) = make_vault("x");
        let (_, other_db, _) = make_vault("y");
        let c = build_container(&m, &other_db); // valid checksum, wrong db
        let e = parse_container(&c).err().unwrap();
        assert!(e.contains("different vault"), "{e}");
    }

    #[test]
    fn no_overwrite_without_replace_and_replace_keeps_previous() {
        let (m1, d1, _) = make_vault("one");
        let (m2, d2, _) = make_vault("two");
        let dir = tmp("rep");
        let (mf, df) = (dir.join("vault.json"), dir.join("vault.nqdb"));
        install(&dir, &mf, &df, &build_container(&m1, &d1), false, 1).unwrap();
        let c2 = build_container(&m2, &d2);

        assert!(install(&dir, &mf, &df, &c2, false, 2).is_err());
        assert_eq!(fs::read(&mf).unwrap(), m1); // untouched
        assert!(!dir.join("before-restore-2").exists());

        let r = install(&dir, &mf, &df, &c2, true, 3).unwrap();
        assert!(r.replaced);
        let keep = dir.join("before-restore-3");
        assert_eq!(fs::read(keep.join("vault.json")).unwrap(), m1);
        assert_eq!(fs::read(keep.join("vault.nqdb")).unwrap(), d1);
        assert_eq!(fs::read(&mf).unwrap(), m2);
        assert_eq!(fs::read(&df).unwrap(), d2);
        let _ = fs::remove_dir_all(dir);
    }

    // ─── merge ───────────────────────────────────────────────────────────────

    /// This device's unlocked vault on disk (vault.json + vault.nqdb in `dir`), with `notes`.
    fn current_vault(name: &str, password: &str, notes: &[(&str, &str)]) -> (PathBuf, VaultState, VaultMeta) {
        let dir = tmp(name);
        let (meta, key, _) = create_vault(password, FAST).unwrap();
        fs::write(dir.join("vault.json"), meta.to_json()).unwrap();
        let vs = VaultState::default();
        vs.ensure_device(&dir);
        vs.set_root(dir.clone());
        vs.install_key(key, meta.vault_id_bytes().unwrap());
        vs.with_db(|db, _, _, _| { for (p, c) in notes { db.put(p, "md", c)?; } Ok(((), true)) }).unwrap();
        (dir, vs, meta)
    }

    /// A `.nqbackup` of another vault (its own key and `password`) holding `db`.
    fn backup_of(db: &vdb::Db, password: &str) -> Vec<u8> {
        let (meta, key, _) = create_vault(password, FAST).unwrap();
        build_container(meta.to_json().as_bytes(), &db.seal(&key, &meta.vault_id_bytes().unwrap()).unwrap())
    }

    fn texts(vs: &VaultState) -> Vec<(String, String)> {
        vs.with_db(|db, _, _, _| Ok((db.list().into_iter().filter(|i| !i.dir).map(|i| {
            let c = db.get(&i.rel).unwrap().content.clone();
            (i.rel, c)
        }).collect(), false))).unwrap()
    }

    #[test]
    fn merge_opens_a_backup_with_its_own_password_and_keeps_this_vaults() {
        let (dir, vs, meta) = current_vault("merge-pw", "this-vaults-password-1", &[("mine.nqv", "here")]);
        let meta_file = dir.join("vault.json");
        let meta_before = fs::read(&meta_file).unwrap();
        let mut bdb = vdb::Db::new();
        bdb.device = "b".repeat(32);
        bdb.put("theirs.nqv", "md", "there").unwrap();
        let backup = backup_of(&bdb, "the-backups-password-2");

        assert!(backup_key(&backup, "this-vaults-password-1").is_err(), "this vault's password doesn't open it");
        let key = backup_key(&backup, "the-backups-password-2").unwrap();
        let seq = vs.change_seq();
        let r = merge_into_vault(&vs, &dir, &meta_file, &backup, &key, 7).unwrap();
        assert_eq!((r.counts.added, r.counts.updated, r.counts.unchanged, r.counts.kept_in_history), (1, 0, 0, 0));
        assert!(vs.change_seq() > seq, "a local change, so the next sync uploads it");
        assert_eq!(texts(&vs), vec![("mine.nqv".into(), "here".into()), ("theirs.nqv".into(), "there".into())]);

        // This vault's key file (password, id) is untouched; the merged db opens with this vault's key.
        assert_eq!(fs::read(&meta_file).unwrap(), meta_before);
        let (cur_key, cur_id) = vs.key_copy().unwrap();
        assert_eq!(cur_id, meta.vault_id_bytes().unwrap());
        let on_disk = vdb::Db::open(&cur_key, &cur_id, &fs::read(vdb::db_path(&dir)).unwrap()).unwrap().unwrap();
        assert!(on_disk.get("theirs.nqv").is_some(), "re-sealed with the current key");
        assert!(!vdb::restored_marker_path(&dir).exists(), "stamped at merge time, no restore marker");

        // The pre-merge copy is the vault as it was.
        let keep = dir.join("before-merge-7");
        assert_eq!(r.previous_saved_to.as_deref(), Some(keep.to_string_lossy().as_ref()));
        assert_eq!(fs::read(keep.join("vault.json")).unwrap(), meta_before);
        let old = vdb::Db::open(&cur_key, &cur_id, &fs::read(keep.join("vault.nqdb")).unwrap()).unwrap().unwrap();
        assert!(old.get("mine.nqv").is_some() && old.get("theirs.nqv").is_none());

        // Merging the same backup again: nothing to do, nothing written.
        let again = merge_into_vault(&vs, &dir, &meta_file, &backup, &key, 8).unwrap();
        assert_eq!((again.counts.added, again.counts.unchanged), (0, 1));
        assert!(again.previous_saved_to.is_none() && !dir.join("before-merge-8").exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_with_the_wrong_password_changes_nothing() {
        let (dir, vs, _) = current_vault("merge-wrong", "this-vaults-password-1", &[("mine.nqv", "here")]);
        let meta_file = dir.join("vault.json");
        let mut bdb = vdb::Db::new();
        bdb.put("theirs.nqv", "md", "there").unwrap();
        let backup = backup_of(&bdb, "the-backups-password-2");
        let db_before = fs::read(vdb::db_path(&dir)).unwrap();
        let seq = vs.change_seq();

        assert_eq!(backup_key(&backup, "not-the-password-3").err(), Some(vc::VaultError::WrongPassword));
        // A key that isn't the backup's (here: this vault's) can't open it either.
        let (wrong, _) = vs.key_copy().unwrap();
        assert!(merge_into_vault(&vs, &dir, &meta_file, &backup, &wrong, 9).is_err());

        assert_eq!(fs::read(vdb::db_path(&dir)).unwrap(), db_before);
        assert_eq!(vs.change_seq(), seq);
        assert!(!dir.join("before-merge-9").exists());
        assert_eq!(texts(&vs), vec![("mine.nqv".into(), "here".into())]);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn merge_needs_the_vault_unlocked() {
        let (dir, vs, _) = current_vault("merge-locked", "this-vaults-password-1", &[]);
        let backup = backup_of(&vdb::Db::new(), "the-backups-password-2");
        let key = backup_key(&backup, "the-backups-password-2").unwrap();
        vs.lock_all();
        assert_eq!(merge_into_vault(&vs, &dir, &dir.join("vault.json"), &backup, &key, 1).err().as_deref(), Some(ERR_LOCKED));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn export_path_must_be_absolute_nqbackup() {
        assert!(check_dest("relative.nqbackup").is_err());
        assert!(check_dest(&std::env::temp_dir().join("a.txt").to_string_lossy()).is_err());
        assert!(check_dest(&std::env::temp_dir().join("a.NQBACKUP").to_string_lossy()).is_ok());
    }
}
