//! Telegram backup for Secure Vault notes.
//!
//! Only `.nqv` ciphertext leaves the machine. Each file is uploaded under a
//! random name (no titles or folder names reach Telegram), and an *encrypted*
//! manifest — sealed with the vault key — is pinned in the chat so a restore
//! knows which message belongs to which note. The bot token lives in the OS
//! keychain, never in a file or in the frontend after setup.

use std::{collections::HashMap, fs, path::{Path, PathBuf}, time::Duration};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};

use crate::vault::{atomic_write, VaultState};
use crate::vault_core as vc;

const SERVICE: &str = "notiq-vault-telegram";
const ACCOUNT: &str = "bot-token";
const API: &str = "https://api.telegram.org";
const CFG_FILE: &str = "tg_config.json";
const INDEX_FILE: &str = "tg_index.json";
/// Bots may upload up to 50 MB and download up to 20 MB; stay under both.
const MAX_FILE: u64 = 19 * 1024 * 1024;
const MAX_DEPTH: usize = 6;

// ─── persisted state ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct Config { chat_id: i64 }

#[derive(Serialize, Deserialize, Clone)]
struct Entry { message_id: i64, file_id: String, hash: String }

#[derive(Serialize, Deserialize, Default)]
struct Index {
    files: HashMap<String, Entry>,
    manifest_msg: Option<i64>,
    last_sync: Option<u64>,
}

fn data_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join(name))
}

fn load_cfg(app: &AppHandle) -> Result<Option<Config>, String> {
    match fs::read_to_string(data_file(app, CFG_FILE)?) {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn load_index(app: &AppHandle) -> Result<Index, String> {
    match fs::read_to_string(data_file(app, INDEX_FILE)?) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Index::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn save_index(app: &AppHandle, idx: &Index) -> Result<(), String> {
    let s = serde_json::to_vec(idx).map_err(|e| e.to_string())?;
    atomic_write(&data_file(app, INDEX_FILE)?, &s)
}

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

fn load_token() -> Result<String, String> {
    token_entry()?.get_password().map_err(|_| "Telegram isn't set up yet".to_string())
}

// ─── small helpers ───────────────────────────────────────────────────────────

fn sha_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn random_name() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{hex}.nqv")
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A manifest path must be a plain relative `.nqv` path — never `..`, never absolute.
fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && rel.to_ascii_lowercase().ends_with(".nqv")
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.contains(':')
        && rel.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// All `.nqv` files under `root` as (relative path with `/`, absolute path).
fn collect(root: &Path, dir: &Path, depth: usize, out: &mut Vec<(String, PathBuf)>) {
    if depth > MAX_DEPTH { return; }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        if name.starts_with('.') { continue; }
        let path = ent.path();
        let Ok(ft) = ent.file_type() else { continue };
        if ft.is_dir() {
            collect(root, &path, depth + 1, out);
        } else if ft.is_file() && name.to_ascii_lowercase().ends_with(".nqv") {
            if let Ok(rel) = path.strip_prefix(root) {
                let rel = rel.to_string_lossy().replace('\\', "/");
                out.push((rel, path.clone()));
            }
        }
    }
}

// ─── Telegram HTTP ───────────────────────────────────────────────────────────

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

// reqwest errors embed the request URL (which contains the bot token), so
// every error is stripped of it before it can reach logs or the UI.
fn net(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

async fn parse(resp: reqwest::Response) -> Result<Value, String> {
    let status = resp.status();
    let v: Value = resp.json().await.map_err(net)?;
    if v["ok"].as_bool() == Some(true) {
        Ok(v["result"].clone())
    } else {
        Err(format!(
            "Telegram error {}: {}",
            status.as_u16(),
            v["description"].as_str().unwrap_or("unknown error")
        ))
    }
}

async fn api(c: &reqwest::Client, token: &str, method: &str, body: &Value) -> Result<Value, String> {
    let resp = c.post(format!("{API}/bot{token}/{method}")).json(body).send().await.map_err(net)?;
    parse(resp).await
}

async fn send_document(
    c: &reqwest::Client, token: &str, chat_id: i64, bytes: Vec<u8>,
) -> Result<(i64, String), String> {
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(random_name())
        .mime_str("application/octet-stream")
        .map_err(|e| e.to_string())?;
    let form = reqwest::multipart::Form::new()
        .text("chat_id", chat_id.to_string())
        .text("disable_notification", "true")
        .part("document", part);
    let resp = c.post(format!("{API}/bot{token}/sendDocument")).multipart(form).send().await.map_err(net)?;
    let r = parse(resp).await?;
    let mid = r["message_id"].as_i64().ok_or("Unexpected reply from Telegram")?;
    let fid = r["document"]["file_id"].as_str().ok_or("Unexpected reply from Telegram")?.to_string();
    Ok((mid, fid))
}

async fn download(c: &reqwest::Client, token: &str, file_id: &str) -> Result<Vec<u8>, String> {
    let info = api(c, token, "getFile", &json!({ "file_id": file_id })).await?;
    let path = info["file_path"].as_str().ok_or("Telegram has no file for this backup")?;
    let resp = c.get(format!("{API}/file/bot{token}/{path}")).send().await.map_err(net)?;
    if !resp.status().is_success() {
        return Err(format!("Download failed ({})", resp.status().as_u16()));
    }
    let bytes = resp.bytes().await.map_err(net)?;
    if bytes.len() as u64 > MAX_FILE + 1024 * 1024 {
        return Err("Downloaded file is unexpectedly large".into());
    }
    Ok(bytes.to_vec())
}

// ─── commands ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct TgStatus { configured: bool, chat_id: Option<i64>, last_sync: Option<u64> }

#[tauri::command]
pub fn tg_status(app: AppHandle) -> Result<TgStatus, String> {
    let cfg = load_cfg(&app)?;
    let has_token = token_entry().and_then(|e| e.get_password().map_err(|e| e.to_string())).is_ok();
    Ok(TgStatus {
        configured: cfg.is_some() && has_token,
        chat_id: cfg.map(|c| c.chat_id),
        last_sync: load_index(&app)?.last_sync,
    })
}

/// After the user has sent /start to their bot: find the private chat id.
#[tauri::command]
pub async fn tg_detect_chat(token: String) -> Result<i64, String> {
    let c = client()?;
    api(&c, &token, "getMe", &json!({})).await.map_err(|_| "That bot token isn't valid".to_string())?;
    let updates = api(&c, &token, "getUpdates", &json!({ "limit": 50, "timeout": 0 })).await?;
    updates
        .as_array()
        .and_then(|a| {
            a.iter().rev().find_map(|u| {
                let chat = &u["message"]["chat"];
                if chat["type"].as_str() == Some("private") { chat["id"].as_i64() } else { None }
            })
        })
        .ok_or_else(|| "No chat found. Open your bot in Telegram, press Start, then try again.".to_string())
}

#[tauri::command]
pub async fn tg_save_config(app: AppHandle, token: String, chat_id: i64) -> Result<String, String> {
    let c = client()?;
    let me = api(&c, &token, "getMe", &json!({})).await.map_err(|_| "That bot token isn't valid".to_string())?;
    token_entry()?.set_password(&token).map_err(|e| e.to_string())?;
    let cfg = serde_json::to_vec(&Config { chat_id }).map_err(|e| e.to_string())?;
    atomic_write(&data_file(&app, CFG_FILE)?, &cfg)?;
    Ok(me["username"].as_str().unwrap_or("bot").to_string())
}

#[tauri::command]
pub fn tg_clear(app: AppHandle) -> Result<(), String> {
    if let Ok(e) = token_entry() { let _ = e.delete_credential(); }
    for f in [CFG_FILE, INDEX_FILE] {
        let _ = fs::remove_file(data_file(&app, f)?);
    }
    Ok(())
}

#[derive(Serialize)]
pub struct FileState { rel: String, state: &'static str }

/// Per-file sync badge: "synced", "modified" (changed since upload) or "new".
#[tauri::command]
pub fn tg_sync_state(app: AppHandle, root: String) -> Result<Vec<FileState>, String> {
    if load_cfg(&app)?.is_none() { return Ok(vec![]); }
    let idx = load_index(&app)?;
    let root = PathBuf::from(root);
    let mut files = vec![];
    collect(&root, &root, 0, &mut files);
    Ok(files
        .into_iter()
        .map(|(rel, path)| {
            let state = match (idx.files.get(&rel), fs::read(&path)) {
                (Some(e), Ok(b)) if e.hash == sha_hex(&b) => "synced",
                (Some(_), _) => "modified",
                (None, _) => "new",
            };
            FileState { rel, state }
        })
        .collect())
}

#[derive(Serialize, Default)]
pub struct SyncReport { uploaded: u32, skipped: u32, failed: Vec<String> }

/// Uploads new/changed notes, then refreshes the encrypted, pinned manifest.
/// Requires the vault to be unlocked (the manifest is sealed with its key).
#[tauri::command]
pub async fn tg_sync(app: AppHandle, state: State<'_, VaultState>, root: String) -> Result<SyncReport, String> {
    let token = load_token()?;
    let cfg = load_cfg(&app)?.ok_or("Telegram isn't set up yet")?;
    state.with_unlocked(|_, _| Ok(()))?;

    let root = PathBuf::from(root);
    let mut files = vec![];
    collect(&root, &root, 0, &mut files);
    files.sort();

    let c = client()?;
    let mut idx = load_index(&app)?;
    let mut rep = SyncReport::default();
    let mut changed = false;

    for (rel, path) in files {
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(e) => { rep.failed.push(format!("{rel}: {e}")); continue; }
        };
        if bytes.len() as u64 > MAX_FILE {
            rep.failed.push(format!("{rel}: larger than 19 MB"));
            continue;
        }
        let hash = sha_hex(&bytes);
        if idx.files.get(&rel).map(|e| e.hash == hash).unwrap_or(false) {
            rep.skipped += 1;
            continue;
        }
        let old = idx.files.get(&rel).map(|e| e.message_id);
        match send_document(&c, &token, cfg.chat_id, bytes).await {
            Ok((message_id, file_id)) => {
                if let Some(old) = old {
                    let _ = api(&c, &token, "deleteMessage", &json!({ "chat_id": cfg.chat_id, "message_id": old })).await;
                }
                idx.files.insert(rel, Entry { message_id, file_id, hash });
                rep.uploaded += 1;
                changed = true;
                save_index(&app, &idx)?;
            }
            Err(e) => rep.failed.push(format!("{rel}: {e}")),
        }
    }

    if changed || idx.manifest_msg.is_none() {
        let manifest = json!({
            "v": 1,
            "files": idx.files.iter().map(|(rel, e)| json!({
                "rel": rel, "message_id": e.message_id, "file_id": e.file_id, "hash": e.hash,
            })).collect::<Vec<_>>(),
        });
        let plain = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        let sealed = state.with_unlocked(|k, id| vc::seal(k, id, "json", &plain).map_err(|e| e.to_string()))?;
        match send_document(&c, &token, cfg.chat_id, sealed).await {
            Ok((mid, _)) => {
                let pin = api(&c, &token, "pinChatMessage",
                    &json!({ "chat_id": cfg.chat_id, "message_id": mid, "disable_notification": true })).await;
                if let Err(e) = pin { rep.failed.push(format!("manifest not pinned: {e}")); }
                if let Some(old) = idx.manifest_msg {
                    let _ = api(&c, &token, "deleteMessage", &json!({ "chat_id": cfg.chat_id, "message_id": old })).await;
                }
                idx.manifest_msg = Some(mid);
            }
            Err(e) => rep.failed.push(format!("manifest: {e}")),
        }
    }

    idx.last_sync = Some(now_secs());
    save_index(&app, &idx)?;
    Ok(rep)
}

#[derive(Serialize, Default)]
pub struct RestoreReport { restored: u32, skipped: u32, conflicts: u32, failed: Vec<String> }

/// Downloads notes listed in the pinned manifest. Never overwrites: a local
/// file with different content is kept and the backup is saved beside it as a
/// "(restored …)" copy.
#[tauri::command]
pub async fn tg_restore(app: AppHandle, state: State<'_, VaultState>, root: String) -> Result<RestoreReport, String> {
    let token = load_token()?;
    let cfg = load_cfg(&app)?.ok_or("Telegram isn't set up yet")?;
    state.with_unlocked(|_, _| Ok(()))?;

    let c = client()?;
    let chat = api(&c, &token, "getChat", &json!({ "chat_id": cfg.chat_id })).await?;
    let man_file = chat["pinned_message"]["document"]["file_id"]
        .as_str()
        .ok_or("No backup found in this chat (nothing pinned)")?
        .to_string();
    let man_msg = chat["pinned_message"]["message_id"].as_i64();

    let sealed = download(&c, &token, &man_file).await?;
    let (_ext, plain): (String, zeroize::Zeroizing<Vec<u8>>) = state
        .with_unlocked(|k, id| vc::open(k, id, &sealed).map_err(|e| e.to_string()))
        .map_err(|_| "This backup belongs to a different vault or is corrupted".to_string())?;
    let manifest: Value = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
    let list = manifest["files"].as_array().ok_or("Backup manifest is malformed")?;

    let root = PathBuf::from(root);
    let mut idx = load_index(&app)?;
    let mut rep = RestoreReport::default();

    for f in list {
        let (Some(rel), Some(fid), Some(mid), Some(hash)) = (
            f["rel"].as_str(), f["file_id"].as_str(), f["message_id"].as_i64(), f["hash"].as_str(),
        ) else { rep.failed.push("malformed entry".into()); continue };
        if !safe_rel(rel) { rep.failed.push(format!("{rel}: unsafe path skipped")); continue; }

        let target = root.join(rel);
        if let Ok(existing) = fs::read(&target) {
            if sha_hex(&existing) == hash {
                rep.skipped += 1;
                idx.files.insert(rel.to_string(), Entry { message_id: mid, file_id: fid.to_string(), hash: hash.to_string() });
                continue;
            }
        }
        let bytes = match download(&c, &token, fid).await {
            Ok(b) => b,
            Err(e) => { rep.failed.push(format!("{rel}: {e}")); continue; }
        };
        if sha_hex(&bytes) != hash {
            rep.failed.push(format!("{rel}: checksum mismatch, not restored"));
            continue;
        }
        let dest = if target.exists() {
            rep.conflicts += 1;
            let stem = rel.trim_end_matches(".nqv").trim_end_matches(".NQV");
            root.join(format!("{stem} (restored {}).nqv", now_secs()))
        } else {
            target
        };
        match atomic_write(&dest, &bytes) {
            Ok(()) => {
                rep.restored += 1;
                idx.files.insert(rel.to_string(), Entry { message_id: mid, file_id: fid.to_string(), hash: hash.to_string() });
            }
            Err(e) => rep.failed.push(format!("{rel}: {e}")),
        }
    }
    if idx.manifest_msg.is_none() { idx.manifest_msg = man_msg; }
    save_index(&app, &idx)?;
    Ok(rep)
}
