//! Telegram storage backend: the user's own bot, a private chat as the store.
//!
//! Only ciphertext is uploaded, under random file names. Blob ids are
//! `<message_id>:<file_id>`. The sync-state document is the chat's pinned
//! message. The bot token lives in the OS keychain.

use std::{fs, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::sync::{self, data_file, random_name, Backend, MAX_FILE};
use crate::vault::atomic_write;

const SERVICE: &str = "notiq-vault-telegram";
const ACCOUNT: &str = "bot-token";
const API: &str = "https://api.telegram.org";
const CFG_FILE: &str = "tg_config.json";

#[derive(Serialize, Deserialize, Clone)]
struct Config { chat_id: i64 }

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

fn token_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
}

// reqwest errors embed the request URL (which contains the bot token), so
// every error is stripped of it before it can reach logs or the UI.
fn net(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
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

/// A connected bot + chat.
pub struct TgStore { token: String, chat_id: i64, http: reqwest::Client }

impl TgStore {
    fn new(token: String, chat_id: i64) -> Result<Self, String> {
        Ok(Self { token, chat_id, http: client()? })
    }

    /// `None` if Telegram isn't set up (no token or no chat).
    pub(crate) fn load(app: &AppHandle) -> Result<Option<Self>, String> {
        let (Some(cfg), Ok(token)) = (load_cfg(app)?, token_entry().and_then(|e| e.get_password().map_err(|e| e.to_string()))) else {
            return Ok(None);
        };
        Self::new(token, cfg.chat_id).map(Some)
    }

    pub(crate) fn detail(app: &AppHandle) -> Option<String> {
        let cfg = load_cfg(app).ok().flatten()?;
        token_entry().ok()?.get_password().ok()?;
        Some(format!("Telegram chat {}", cfg.chat_id))
    }

    pub(crate) fn clear(app: &AppHandle) -> Result<(), String> {
        if let Ok(e) = token_entry() { let _ = e.delete_credential(); }
        let _ = fs::remove_file(data_file(app, CFG_FILE)?);
        Ok(())
    }

    async fn call(&self, method: &str, body: &Value) -> Result<Value, String> {
        let resp = self.http.post(format!("{API}/bot{}/{method}", self.token)).json(body).send().await.map_err(net)?;
        parse(resp).await
    }

    async fn send_document(&self, bytes: Vec<u8>) -> Result<(i64, String), String> {
        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(random_name())
            .mime_str("application/octet-stream")
            .map_err(|e| e.to_string())?;
        let form = reqwest::multipart::Form::new()
            .text("chat_id", self.chat_id.to_string())
            .text("disable_notification", "true")
            .part("document", part);
        let resp = self.http.post(format!("{API}/bot{}/sendDocument", self.token)).multipart(form).send().await.map_err(net)?;
        let r = parse(resp).await?;
        let mid = r["message_id"].as_i64().ok_or("Unexpected reply from Telegram")?;
        let fid = r["document"]["file_id"].as_str().ok_or("Unexpected reply from Telegram")?.to_string();
        Ok((mid, fid))
    }

    async fn download(&self, file_id: &str) -> Result<Vec<u8>, String> {
        let info = self.call("getFile", &json!({ "file_id": file_id })).await?;
        let path = info["file_path"].as_str().ok_or("Telegram has no file for this backup")?;
        let resp = self.http.get(format!("{API}/file/bot{}/{path}", self.token)).send().await.map_err(net)?;
        if !resp.status().is_success() {
            return Err(format!("Download failed ({})", resp.status().as_u16()));
        }
        let bytes = resp.bytes().await.map_err(net)?;
        if bytes.len() as u64 > MAX_FILE + 1024 * 1024 {
            return Err("Downloaded file is unexpectedly large".into());
        }
        Ok(bytes.to_vec())
    }

    pub(crate) async fn put(&self, bytes: Vec<u8>) -> Result<String, String> {
        let (mid, fid) = self.send_document(bytes).await?;
        Ok(format!("{mid}:{fid}"))
    }

    pub(crate) async fn get(&self, id: &str) -> Result<Vec<u8>, String> {
        let (_, fid) = id.split_once(':').ok_or("Bad Telegram file id")?;
        self.download(fid).await
    }

    pub(crate) async fn delete(&self, id: &str) {
        if let Some(mid) = id.split(':').next().and_then(|m| m.parse::<i64>().ok()) {
            self.delete_message(mid).await;
        }
    }

    async fn delete_message(&self, mid: i64) {
        let _ = self.call("deleteMessage", &json!({ "chat_id": self.chat_id, "message_id": mid })).await;
    }

    /// The pinned document: (message id, file id).
    async fn pinned(&self) -> Result<Option<(i64, String)>, String> {
        let chat = self.call("getChat", &json!({ "chat_id": self.chat_id })).await?;
        let p = &chat["pinned_message"];
        Ok(match (p["message_id"].as_i64(), p["document"]["file_id"].as_str()) {
            (Some(m), Some(f)) => Some((m, f.to_string())),
            _ => None,
        })
    }

    pub(crate) async fn read_state(&self) -> Result<Option<Vec<u8>>, String> {
        match self.pinned().await? {
            Some((_, fid)) => Ok(Some(self.download(&fid).await?)),
            None => Ok(None),
        }
    }

    pub(crate) async fn write_state(&self, bytes: Vec<u8>) -> Result<(), String> {
        let old = self.pinned().await?.map(|(m, _)| m);
        let (mid, _) = self.send_document(bytes).await?;
        self.call("pinChatMessage", &json!({ "chat_id": self.chat_id, "message_id": mid, "disable_notification": true }))
            .await
            .map_err(|e| format!("not pinned: {e}"))?;
        if let Some(o) = old { if o != mid { self.delete_message(o).await; } }
        Ok(())
    }
}

// ─── commands ────────────────────────────────────────────────────────────────

/// After the user has sent /start to their bot: find the private chat id.
#[tauri::command]
pub async fn tg_detect_chat(token: String) -> Result<i64, String> {
    let c = client()?;
    let call = |m: &'static str, b: Value| {
        let c = c.clone();
        let token = token.clone();
        async move {
            let resp = c.post(format!("{API}/bot{token}/{m}")).json(&b).send().await.map_err(net)?;
            parse(resp).await
        }
    };
    call("getMe", json!({})).await.map_err(|_| "That bot token isn't valid".to_string())?;
    let updates = call("getUpdates", json!({ "limit": 50, "timeout": 0 })).await?;
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

/// Validates the bot, stores the token in the keychain and selects Telegram.
#[tauri::command]
pub async fn tg_connect(app: AppHandle, token: String, chat_id: i64) -> Result<String, String> {
    let store = TgStore::new(token.clone(), chat_id)?;
    let me = store.call("getMe", &json!({})).await.map_err(|_| "That bot token isn't valid".to_string())?;
    token_entry()?.set_password(&token).map_err(|e| e.to_string())?;
    save_cfg(&app, chat_id)?;
    sync::set_provider(&app, "telegram")?;
    Ok(me["username"].as_str().unwrap_or("bot").to_string())
}

/// New machine: no vault yet. Connect the bot and install the key file from the
/// pinned sync-state document. Then unlock and sync.
#[tauri::command]
pub async fn tg_bootstrap(app: AppHandle, token: String, chat_id: i64) -> Result<(), String> {
    let store = TgStore::new(token.clone(), chat_id)?;
    store.call("getMe", &json!({})).await.map_err(|_| "That bot token isn't valid".to_string())?;
    let backend = Backend::Telegram(store);
    sync::bootstrap(&app, &backend).await.map_err(|e| if e == "No Notiq backup found" { "No Notiq backup found in this chat".into() } else { e })?;
    token_entry()?.set_password(&token).map_err(|e| e.to_string())?;
    save_cfg(&app, chat_id)?;
    sync::set_provider(&app, "telegram")?;
    Ok(())
}
