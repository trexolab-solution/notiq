//! Telegram sync for Secure Vault notes (multi-machine).
//!
//! Only `.nqv` ciphertext leaves the machine. Each note is uploaded under a
//! random name (no titles or folder names reach Telegram). One pinned
//! "sync state" document holds the vault key file (`vault.json`, which only
//! contains password/recovery-wrapped keys) plus a manifest sealed with the
//! vault key. Every machine merges against that manifest (three-way, using the
//! last-synced hash as the base), so edits from different machines are pulled,
//! pushed, or — if both sides changed — kept as a "(conflict …)" copy.
//! The bot token lives in the OS keychain.

use std::{collections::HashMap, fs, path::{Path, PathBuf}, time::Duration};

use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroizing;

use crate::vault::{self, atomic_write, VaultState};
use crate::vault_core as vc;

const SERVICE: &str = "notiq-vault-telegram";
const ACCOUNT: &str = "bot-token";
const API: &str = "https://api.telegram.org";
const CFG_FILE: &str = "tg_config.json";
const INDEX_FILE: &str = "tg_index.json";
/// Bots may upload up to 50 MB and download up to 20 MB; stay under both.
const MAX_FILE: u64 = 19 * 1024 * 1024;
const MAX_DEPTH: usize = 6;
const STATE_MAGIC: &[u8; 4] = b"NQS1";

// ─── persisted state ─────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct Config { chat_id: i64 }

/// One note as known on Telegram.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
struct Entry {
    message_id: i64,
    file_id: String,
    hash: String,
    /// Unix seconds of the file's last modification on the uploading machine.
    #[serde(default)]
    updated: u64,
}

/// The sealed manifest (decrypted form).
#[derive(Serialize, Deserialize, Default)]
struct Manifest { v: u32, files: HashMap<String, Entry> }

#[derive(Serialize, Deserialize, Default)]
struct Index {
    #[serde(default)]
    device_id: String,
    /// What was in sync at the end of the last successful run (the merge base).
    #[serde(default)]
    files: HashMap<String, Entry>,
    #[serde(default)]
    state_msg: Option<i64>,
    #[serde(default)]
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

fn save_cfg(app: &AppHandle, chat_id: i64) -> Result<(), String> {
    let cfg = serde_json::to_vec(&Config { chat_id }).map_err(|e| e.to_string())?;
    atomic_write(&data_file(app, CFG_FILE)?, &cfg)
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

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn random_name() -> String {
    format!("{}.nqv", random_hex(16))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
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

/// `<dir>/<stem> (conflict <ts>).nqv` next to the original.
fn conflict_rel(rel: &str, ts: u64) -> String {
    let stem = rel
        .strip_suffix(".nqv")
        .or_else(|| rel.strip_suffix(".NQV"))
        .unwrap_or(rel);
    format!("{stem} (conflict {ts}).nqv")
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

// ─── sync state document ─────────────────────────────────────────────────────
// "NQS1" | u32 BE len | vault.json bytes | sealed manifest

fn pack_state(vault_json: &str, sealed: &[u8]) -> Vec<u8> {
    let vj = vault_json.as_bytes();
    let mut out = Vec::with_capacity(8 + vj.len() + sealed.len());
    out.extend_from_slice(STATE_MAGIC);
    out.extend_from_slice(&(vj.len() as u32).to_be_bytes());
    out.extend_from_slice(vj);
    out.extend_from_slice(sealed);
    out
}

fn unpack_state(b: &[u8]) -> Result<(String, Vec<u8>), String> {
    if b.len() < 8 || &b[..4] != STATE_MAGIC {
        return Err("Unrecognised backup format".into());
    }
    let n = u32::from_be_bytes([b[4], b[5], b[6], b[7]]) as usize;
    if b.len() < 8 + n { return Err("Backup is truncated".into()); }
    let vj = String::from_utf8(b[8..8 + n].to_vec()).map_err(|_| "Backup is corrupted".to_string())?;
    Ok((vj, b[8 + n..].to_vec()))
}

// ─── merge planning (pure, unit-tested) ──────────────────────────────────────

#[derive(Debug, Clone)]
struct LocalFile { rel: String, hash: String, updated: u64 }

#[derive(Debug, PartialEq)]
enum Action {
    InSync(String),
    Upload(String),
    Download(String),
    /// Both sides changed; local is newer → keep local, save remote as a conflict copy.
    ConflictKeepLocal(String),
    /// Both sides changed; remote is newer → take remote, save local as a conflict copy.
    ConflictKeepRemote(String),
}

/// Three-way decision per note. `base` is what was in sync after the last run.
fn plan(local: &[LocalFile], remote: &HashMap<String, Entry>, base: &HashMap<String, Entry>) -> Vec<Action> {
    let l: HashMap<&str, &LocalFile> = local.iter().map(|f| (f.rel.as_str(), f)).collect();
    let mut rels: Vec<&str> = l.keys().copied().chain(remote.keys().map(|s| s.as_str())).collect();
    rels.sort_unstable();
    rels.dedup();
    rels.into_iter()
        .map(|rel| match (l.get(rel), remote.get(rel)) {
            (Some(_), None) => Action::Upload(rel.into()),
            (None, Some(_)) => Action::Download(rel.into()),
            (Some(lf), Some(re)) => {
                if lf.hash == re.hash {
                    Action::InSync(rel.into())
                } else {
                    let b = base.get(rel).map(|e| e.hash.as_str());
                    if b == Some(re.hash.as_str()) {
                        Action::Upload(rel.into()) // only we changed
                    } else if b == Some(lf.hash.as_str()) {
                        Action::Download(rel.into()) // only they changed
                    } else if lf.updated >= re.updated {
                        Action::ConflictKeepLocal(rel.into())
                    } else {
                        Action::ConflictKeepRemote(rel.into())
                    }
                }
            }
            (None, None) => unreachable!(),
        })
        .collect()
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

async fn delete_message(c: &reqwest::Client, token: &str, chat_id: i64, message_id: i64) {
    let _ = api(c, token, "deleteMessage", &json!({ "chat_id": chat_id, "message_id": message_id })).await;
}

/// The pinned sync-state document: (message id, bytes), or None if nothing is pinned.
async fn fetch_state(c: &reqwest::Client, token: &str, chat_id: i64) -> Result<Option<(i64, Vec<u8>)>, String> {
    let chat = api(c, token, "getChat", &json!({ "chat_id": chat_id })).await?;
    let pinned = &chat["pinned_message"];
    let (Some(mid), Some(fid)) = (pinned["message_id"].as_i64(), pinned["document"]["file_id"].as_str()) else {
        return Ok(None);
    };
    Ok(Some((mid, download(c, token, fid).await?)))
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
    save_cfg(&app, chat_id)?;
    Ok(me["username"].as_str().unwrap_or("bot").to_string())
}

/// New machine: no vault yet. Connect the bot, fetch the key file from the
/// pinned sync-state document and install it. The user then unlocks with the
/// master password and runs a normal sync to pull every note.
#[tauri::command]
pub async fn tg_bootstrap(app: AppHandle, token: String, chat_id: i64) -> Result<(), String> {
    if vault::read_meta_json(&app)?.is_some() {
        return Err("A vault already exists on this device".into());
    }
    let c = client()?;
    api(&c, &token, "getMe", &json!({})).await.map_err(|_| "That bot token isn't valid".to_string())?;
    let (_, bytes) = fetch_state(&c, &token, chat_id)
        .await?
        .ok_or("No Notiq backup found in this chat")?;
    let (vault_json, _) = unpack_state(&bytes)
        .map_err(|_| "The pinned message isn't a Notiq backup (was it made by an older version? Sync once from your original device first)".to_string())?;
    vault::install_meta_json(&app, &vault_json)?;
    token_entry()?.set_password(&token).map_err(|e| e.to_string())?;
    save_cfg(&app, chat_id)?;
    Ok(())
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

/// Per-file sync badge: "synced", "modified" (changed since last sync) or "new".
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
pub struct SyncReport {
    uploaded: u32,
    /// Relative paths replaced/created locally (so the UI can reload open tabs).
    downloaded: Vec<String>,
    conflicts: u32,
    skipped: u32,
    failed: Vec<String>,
}

/// Two-way sync: pull what changed elsewhere, push what changed here.
/// Requires the vault to be unlocked (the manifest is sealed with its key).
/// Never deletes anything.
#[tauri::command]
pub async fn tg_sync(app: AppHandle, state: State<'_, VaultState>, root: String) -> Result<SyncReport, String> {
    let token = load_token()?;
    let cfg = load_cfg(&app)?.ok_or("Telegram isn't set up yet")?;
    state.with_unlocked(|_, _| Ok(()))?;

    let root = PathBuf::from(root);
    let c = client()?;
    let mut idx = load_index(&app)?;
    if idx.device_id.is_empty() { idx.device_id = random_hex(4); }
    let mut rep = SyncReport::default();

    // 1. Remote state (manifest sealed with the vault key).
    let remote_state = fetch_state(&c, &token, cfg.chat_id).await?;
    let mut need_state_upload = false;
    let mut old_state_msg = idx.state_msg;
    let mut remote: HashMap<String, Entry> = HashMap::new();
    match &remote_state {
        Some((mid, bytes)) => {
            old_state_msg = Some(*mid);
            match unpack_state(bytes) {
                Ok((_vault_json, sealed)) => {
                    let (_ext, plain): (String, Zeroizing<Vec<u8>>) = state
                        .with_unlocked(|k, id| vc::open(k, id, &sealed).map_err(|e| e.to_string()))
                        .map_err(|_| "This backup belongs to a different vault or is corrupted".to_string())?;
                    let m: Manifest = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
                    remote = m.files;
                }
                // Older/unknown pinned message: replace it with a proper state document.
                Err(_) => need_state_upload = true,
            }
        }
        None => need_state_upload = true,
    }

    // 2. Local files.
    let mut found = vec![];
    collect(&root, &root, 0, &mut found);
    found.sort();
    let mut locals = vec![];
    for (rel, path) in found {
        match fs::read(&path) {
            Ok(b) if b.len() as u64 > MAX_FILE => rep.failed.push(format!("{rel}: larger than 19 MB")),
            Ok(b) => locals.push(LocalFile { rel, hash: sha_hex(&b), updated: mtime_secs(&path) }),
            Err(e) => rep.failed.push(format!("{rel}: {e}")),
        }
    }
    let local_map: HashMap<String, LocalFile> = locals.iter().cloned().map(|f| (f.rel.clone(), f)).collect();

    // 3. Execute the plan.
    let mut manifest_changed = false;
    let ts = now_secs();
    for action in plan(&locals, &remote, &idx.files) {
        match action {
            Action::InSync(rel) => {
                rep.skipped += 1;
                let _ = rel;
            }
            Action::Upload(rel) | Action::ConflictKeepLocal(rel) => {
                let keep_local_conflict = matches!(&action_kind(&rel, &remote, &local_map, &idx.files), Kind::Conflict);
                let result: Result<(), String> = async {
                    if keep_local_conflict {
                        // Save the other machine's version beside ours first.
                        let r = remote.get(&rel).ok_or("missing remote entry")?;
                        let bytes = download(&c, &token, &r.file_id).await?;
                        if sha_hex(&bytes) == r.hash {
                            atomic_write(&root.join(conflict_rel(&rel, ts)), &bytes)?;
                            rep.conflicts += 1;
                        }
                    }
                    let lf = local_map.get(&rel).ok_or("local file vanished")?;
                    let bytes = fs::read(root.join(&rel)).map_err(|e| e.to_string())?;
                    if sha_hex(&bytes) != lf.hash { return Err("changed while syncing, will retry".into()); }
                    let (message_id, file_id) = send_document(&c, &token, cfg.chat_id, bytes).await?;
                    if let Some(old) = remote.get(&rel) { delete_message(&c, &token, cfg.chat_id, old.message_id).await; }
                    remote.insert(rel.clone(), Entry { message_id, file_id, hash: lf.hash.clone(), updated: lf.updated });
                    rep.uploaded += 1;
                    manifest_changed = true;
                    Ok(())
                }
                .await;
                if let Err(e) = result { rep.failed.push(format!("{rel}: {e}")); }
            }
            Action::Download(rel) | Action::ConflictKeepRemote(rel) => {
                let kind = action_kind(&rel, &remote, &local_map, &idx.files);
                let result: Result<(), String> = async {
                    if !safe_rel(&rel) { return Err("unsafe path skipped".into()); }
                    let r = remote.get(&rel).ok_or("missing remote entry")?.clone();
                    let bytes = download(&c, &token, &r.file_id).await?;
                    if sha_hex(&bytes) != r.hash { return Err("checksum mismatch, not downloaded".into()); }
                    let target = root.join(&rel);
                    if matches!(kind, Kind::Conflict) && target.exists() {
                        fs::copy(&target, root.join(conflict_rel(&rel, ts))).map_err(|e| e.to_string())?;
                        rep.conflicts += 1;
                    }
                    atomic_write(&target, &bytes)?;
                    rep.downloaded.push(rel.clone());
                    Ok(())
                }
                .await;
                if let Err(e) = result { rep.failed.push(format!("{rel}: {e}")); }
            }
        }
    }

    // 4. Publish the merged manifest (+ key file) as the new pinned state.
    if manifest_changed || need_state_upload {
        let manifest = Manifest { v: 2, files: remote.clone() };
        let plain = serde_json::to_vec(&manifest).map_err(|e| e.to_string())?;
        let sealed = state.with_unlocked(|k, id| vc::seal(k, id, "json", &plain).map_err(|e| e.to_string()))?;
        let vault_json = vault::read_meta_json(&app)?.ok_or("No vault on this device")?;
        match send_document(&c, &token, cfg.chat_id, pack_state(&vault_json, &sealed)).await {
            Ok((mid, _)) => {
                let pin = api(&c, &token, "pinChatMessage",
                    &json!({ "chat_id": cfg.chat_id, "message_id": mid, "disable_notification": true })).await;
                match pin {
                    Ok(_) => {
                        for old in [old_state_msg, idx.state_msg].into_iter().flatten() {
                            if old != mid { delete_message(&c, &token, cfg.chat_id, old).await; }
                        }
                        idx.state_msg = Some(mid);
                    }
                    Err(e) => rep.failed.push(format!("sync state not pinned: {e}")),
                }
            }
            Err(e) => rep.failed.push(format!("sync state: {e}")),
        }
    }

    idx.files = remote;
    idx.last_sync = Some(now_secs());
    save_index(&app, &idx)?;
    Ok(rep)
}

enum Kind { Plain, Conflict }

/// Whether this note is a true conflict (no usable merge base) — decided again
/// at execution time so the plan stays a simple list of actions.
fn action_kind(
    rel: &str,
    remote: &HashMap<String, Entry>,
    local: &HashMap<String, LocalFile>,
    base: &HashMap<String, Entry>,
) -> Kind {
    match (local.get(rel), remote.get(rel)) {
        (Some(l), Some(r)) if l.hash != r.hash => {
            let b = base.get(rel).map(|e| e.hash.as_str());
            if b == Some(r.hash.as_str()) || b == Some(l.hash.as_str()) { Kind::Plain } else { Kind::Conflict }
        }
        _ => Kind::Plain,
    }
}

// ─── tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn e(hash: &str, updated: u64) -> Entry {
        Entry { message_id: 1, file_id: "f".into(), hash: hash.into(), updated }
    }
    fn l(rel: &str, hash: &str, updated: u64) -> LocalFile {
        LocalFile { rel: rel.into(), hash: hash.into(), updated }
    }
    fn map(items: &[(&str, Entry)]) -> HashMap<String, Entry> {
        items.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn new_local_is_uploaded_new_remote_is_downloaded() {
        let a = plan(&[l("a.nqv", "h1", 1)], &map(&[("b.nqv", e("h2", 1))]), &HashMap::new());
        assert_eq!(a, vec![Action::Upload("a.nqv".into()), Action::Download("b.nqv".into())]);
    }

    #[test]
    fn identical_is_in_sync() {
        let a = plan(&[l("a.nqv", "h", 5)], &map(&[("a.nqv", e("h", 9))]), &HashMap::new());
        assert_eq!(a, vec![Action::InSync("a.nqv".into())]);
    }

    #[test]
    fn only_local_changed_uploads() {
        let base = map(&[("a.nqv", e("old", 1))]);
        let a = plan(&[l("a.nqv", "new", 5)], &map(&[("a.nqv", e("old", 1))]), &base);
        assert_eq!(a, vec![Action::Upload("a.nqv".into())]);
    }

    #[test]
    fn only_remote_changed_downloads() {
        let base = map(&[("a.nqv", e("old", 1))]);
        let a = plan(&[l("a.nqv", "old", 1)], &map(&[("a.nqv", e("new", 9))]), &base);
        assert_eq!(a, vec![Action::Download("a.nqv".into())]);
    }

    #[test]
    fn both_changed_newer_side_wins() {
        let base = map(&[("a.nqv", e("old", 1))]);
        let keep_local = plan(&[l("a.nqv", "x", 10)], &map(&[("a.nqv", e("y", 5))]), &base);
        assert_eq!(keep_local, vec![Action::ConflictKeepLocal("a.nqv".into())]);
        let keep_remote = plan(&[l("a.nqv", "x", 5)], &map(&[("a.nqv", e("y", 10))]), &base);
        assert_eq!(keep_remote, vec![Action::ConflictKeepRemote("a.nqv".into())]);
    }

    #[test]
    fn differing_without_a_base_is_a_conflict() {
        let a = plan(&[l("a.nqv", "x", 3)], &map(&[("a.nqv", e("y", 4))]), &HashMap::new());
        assert_eq!(a, vec![Action::ConflictKeepRemote("a.nqv".into())]);
    }

    #[test]
    fn locally_deleted_notes_come_back_never_deleted_remotely() {
        let base = map(&[("a.nqv", e("h", 1))]);
        let a = plan(&[], &map(&[("a.nqv", e("h", 1))]), &base);
        assert_eq!(a, vec![Action::Download("a.nqv".into())]);
    }

    #[test]
    fn state_document_round_trips() {
        let packed = pack_state("{\"v\":1}", &[1, 2, 3]);
        let (vj, sealed) = unpack_state(&packed).unwrap();
        assert_eq!(vj, "{\"v\":1}");
        assert_eq!(sealed, vec![1, 2, 3]);
        assert!(unpack_state(b"nope").is_err());
        assert!(unpack_state(b"NQS1\x00\x00\x00\xffxx").is_err());
    }

    #[test]
    fn rel_paths_are_validated_and_conflict_names_stay_beside_the_original() {
        assert!(safe_rel("SSH/server.nqv"));
        assert!(!safe_rel("../x.nqv") && !safe_rel("/abs.nqv") && !safe_rel("a\\b.nqv") && !safe_rel("a.txt"));
        assert_eq!(conflict_rel("SSH/server.nqv", 7), "SSH/server (conflict 7).nqv");
    }
}
