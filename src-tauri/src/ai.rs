// ─── AI backend (Ollama Cloud + Local, OpenAI-compatible) ─────────────────────
//
// All network calls go through Rust (reqwest) so the API key never lives in the
// webview and there are no CORS issues talking to https://ollama.com. The key is
// stored securely using the OS keyring.
//
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use keyring::Entry;
use futures_util::StreamExt;

const SERVICE_NAME: &str = "notiq-ai";
const ACCOUNT_NAME: &str = "api-key";

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone)]
struct StreamPayload {
    request_id: String,
    token: String,
    is_final: bool,
    /// Why generation stopped, on the final event: "stop", "length", etc.
    finish_reason: Option<String>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Trim a server error body to a reasonable length for display.
fn snippet(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() > 300 {
        t.chars().take(300).collect()
    } else {
        t.to_string()
    }
}

// ─── Key management ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn set_ai_api_key(_app: AppHandle, key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return clear_ai_api_key(_app);
    }
    let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME).map_err(|e| e.to_string())?;
    entry.set_password(key.trim()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn has_ai_api_key(_app: AppHandle) -> bool {
    read_api_key().is_empty() == false
}

#[tauri::command]
pub fn clear_ai_api_key(_app: AppHandle) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, ACCOUNT_NAME).map_err(|e| e.to_string())?;
    // Clear the secret by setting it to an empty string.
    entry.set_password("").map_err(|e| e.to_string())?;
    Ok(())
}

fn read_api_key() -> String {
    Entry::new(SERVICE_NAME, ACCOUNT_NAME)
        .and_then(|e| e.get_password())
        .unwrap_or_default()
}

fn normalize_base(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

// ─── Inference ────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn ai_list_models(_app: AppHandle, base_url: String) -> Result<Vec<String>, String> {
    let key = read_api_key();
    let url = format!("{}/models", normalize_base(&base_url));
    let client = http_client()?;

    let mut req = client.get(&url);
    if !key.is_empty() {
        req = req.bearer_auth(&key);
    }

    let resp = req.send().await.map_err(|e| format!("network|{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{}|{}", status.as_u16(), snippet(&text)));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse|{}", e))?;

    let mut models = Vec::new();
    if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
        for m in data {
            if let Some(id) = m.get("id").and_then(|i| i.as_str()) {
                models.push(id.to_string());
            }
        }
    }
    Ok(models)
}

#[tauri::command]
pub async fn ai_complete(
    _app: AppHandle,
    base_url: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
) -> Result<String, String> {
    let key = read_api_key();
    let url = format!("{}/chat/completions", normalize_base(&base_url));
    let client = http_client()?;

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": false,
    });

    let mut req = client.post(&url).json(&body);
    if !key.is_empty() {
        req = req.bearer_auth(&key);
    }

    let resp = req.send().await.map_err(|e| format!("network|{}", e))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{}|{}", status.as_u16(), snippet(&text)));
    }

    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse|{}", e))?;

    let content = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    Ok(content)
}

#[tauri::command]
pub async fn ai_complete_stream(
    app: AppHandle,
    request_id: String,
    base_url: String,
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
) -> Result<(), String> {
    let key = read_api_key();
    let url = format!("{}/chat/completions", normalize_base(&base_url));
    let client = http_client()?;

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "stream": true,
    });

    let mut req = client.post(&url).json(&body);
    if !key.is_empty() {
        req = req.bearer_auth(&key);
    }

    let resp = req.send().await.map_err(|e| format!("network|{}", e))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("{}|{}", status.as_u16(), snippet(&text)));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    // Remember the last finish_reason seen so we can report it on the final event.
    let mut last_finish: Option<String> = None;

    let emit_final = |app: &AppHandle, reason: Option<String>| {
        app.emit("ai-stream-token", StreamPayload {
            request_id: request_id.clone(),
            token: String::new(),
            is_final: true,
            finish_reason: reason,
        }).ok();
    };

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("stream|{}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find("\n\n") {
            let line = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" {
                    emit_final(&app, last_finish.clone());
                    return Ok(());
                }

                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) {
                    let choice = parsed.get("choices").and_then(|c| c.get(0));
                    if let Some(reason) = choice
                        .and_then(|c| c.get("finish_reason"))
                        .and_then(|r| r.as_str())
                    {
                        last_finish = Some(reason.to_string());
                    }
                    if let Some(token) = choice
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|t| t.as_str())
                    {
                        app.emit("ai-stream-token", StreamPayload {
                            request_id: request_id.clone(),
                            token: token.to_string(),
                            is_final: false,
                            finish_reason: None,
                        }).ok();
                    }
                }
            }
        }
    }

    // Stream ended without an explicit [DONE] — still emit a final event.
    emit_final(&app, last_finish);
    Ok(())
}
