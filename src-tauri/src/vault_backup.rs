//! Backup export / restore of the local-only vault.
//!
//! Container (`.nqbackup`): magic `NQB1`, u32 BE length + `vault.json` bytes, the raw
//! `vault.nqdb` bytes (still encrypted, never decrypted here), then a CRC-32 (u32 BE)
//! of everything before it so truncation / corruption is detected.

use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::vault::{atomic_write, guarded, load_meta, meta_path, require_meta, VaultState};
use crate::vault_core::{self as vc, VaultMeta, VAULT_ID_LEN};
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

fn build_container(meta: &[u8], db: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(MIN_LEN + meta.len() + db.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&(meta.len() as u32).to_be_bytes());
    out.extend_from_slice(meta);
    out.extend_from_slice(db);
    let crc = crc32(&out);
    out.extend_from_slice(&crc.to_be_bytes());
    out
}

struct Parsed<'a> {
    meta_bytes: &'a [u8],
    db_bytes: &'a [u8],
    meta: VaultMeta,
}

fn parse_container(data: &[u8]) -> Result<Parsed<'_>, String> {
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

/// Writes the backup's files into `meta_file` / `db_file`. An existing vault is refused unless
/// `replace`; then its files are first copied into `<data_dir>/before-restore-<ts>/`.
fn install(data_dir: &Path, meta_file: &Path, db_file: &Path, data: &[u8], replace: bool, ts: u64) -> Result<ImportResult, String> {
    let p = parse_container(data)?;
    let exists = meta_file.exists();
    if exists && !replace {
        return Err("A vault already exists on this device. Restoring would replace it.".into());
    }
    let mut saved = None;
    if exists || db_file.exists() {
        let dir = data_dir.join(format!("before-restore-{ts}"));
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for f in [meta_file, db_file] {
            if f.exists() {
                let name = f.file_name().expect("file name");
                fs::copy(f, dir.join(name)).map_err(|e| format!("Couldn't keep a copy of the current vault: {e}"))?;
            }
        }
        saved = Some(dir.to_string_lossy().into_owned());
    }
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
    install(&data_dir, &meta_file, &vdb::db_path(&root), &data, replace, now_secs())
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

    #[test]
    fn export_path_must_be_absolute_nqbackup() {
        assert!(check_dest("relative.nqbackup").is_err());
        assert!(check_dest(&std::env::temp_dir().join("a.txt").to_string_lossy()).is_err());
        assert!(check_dest(&std::env::temp_dir().join("a.NQBACKUP").to_string_lossy()).is_ok());
    }
}
