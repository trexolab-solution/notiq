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

/// Dev builds use their own keychain entry so they never read or overwrite the installed app's API key.
const SERVICE_NAME: &str = if crate::profile::IS_DEV { "notiq-ai-dev" } else { "notiq-ai" };
const ACCOUNT_CLOUD: &str = "api-key";
const ACCOUNT_OPENROUTER: &str = "openrouter-api-key";
/// Hard cap on the stored API key length — a sane bound for any real token.
const MAX_API_KEY_LEN: usize = 4096;

/// Map a provider id to its keyring account name. `None` means the provider
/// never has a stored key (e.g. "local" — Ollama on localhost needs no auth).
fn account_for(provider: &str) -> Option<&'static str> {
    match provider {
        "cloud" => Some(ACCOUNT_CLOUD),
        "openrouter" => Some(ACCOUNT_OPENROUTER),
        _ => None,
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    id: String,
    context_length: Option<u64>,
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
pub fn set_ai_api_key(_app: AppHandle, provider: String, key: String) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return clear_ai_api_key(_app, provider);
    }
    if trimmed.len() > MAX_API_KEY_LEN {
        return Err(format!("API key is too long (max {} bytes)", MAX_API_KEY_LEN));
    }
    let account = account_for(&provider).ok_or_else(|| format!("'{}' does not use an API key", provider))?;
    let entry = Entry::new(SERVICE_NAME, account).map_err(|e| e.to_string())?;
    entry.set_password(trimmed).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn has_ai_api_key(_app: AppHandle, provider: String) -> bool {
    read_api_key(&provider).is_empty() == false
}

#[tauri::command]
pub fn clear_ai_api_key(_app: AppHandle, provider: String) -> Result<(), String> {
    let account = account_for(&provider).ok_or_else(|| format!("'{}' does not use an API key", provider))?;
    let entry = Entry::new(SERVICE_NAME, account).map_err(|e| e.to_string())?;
    // Clear the secret by setting it to an empty string.
    entry.set_password("").map_err(|e| e.to_string())?;
    Ok(())
}

fn read_api_key(provider: &str) -> String {
    let Some(account) = account_for(provider) else { return String::new() };
    Entry::new(SERVICE_NAME, account)
        .and_then(|e| e.get_password())
        .unwrap_or_default()
}

/// Validate + normalize an AI base URL received from the frontend. Only http(s)
/// is permitted, and plain `http` is restricted to loopback hosts so the bearer
/// token is never transmitted in cleartext to a remote server.
fn validate_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("invalid|empty base URL".to_string());
    }
    let parsed = reqwest::Url::parse(trimmed)
        .map_err(|_| "invalid|base URL is not a valid URL".to_string())?;
    let host = parsed.host_str().unwrap_or("");
    let is_loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    match parsed.scheme() {
        "https" => Ok(trimmed.to_string()),
        "http" if is_loopback => Ok(trimmed.to_string()),
        "http" => Err(
            "invalid|refusing to send credentials over plain HTTP to a non-local host — use HTTPS"
                .to_string(),
        ),
        other => Err(format!("invalid|unsupported URL scheme '{}'", other)),
    }
}

// ─── Inference ────────────────────────────────────────────────────────────────

/// Best-effort: fetch Ollama's native `/api/tags` (richer than the OpenAI-compat
/// `/v1/models`) and return a name → context_length map. Never fails the caller —
/// any error/shape mismatch just yields an empty map.
async fn fetch_ollama_context_lengths(client: &reqwest::Client, base_url: &str) -> std::collections::HashMap<String, u64> {
    let root = base_url.trim_end_matches('/').trim_end_matches("/v1");
    let url = format!("{}/api/tags", root);
    let mut out = std::collections::HashMap::new();

    let Ok(resp) = client.get(&url).send().await else { return out };
    let Ok(text) = resp.text().await else { return out };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else { return out };

    if let Some(models) = parsed.get("models").and_then(|m| m.as_array()) {
        for m in models {
            let name = m.get("name").or_else(|| m.get("model")).and_then(|n| n.as_str());
            let ctx = m.get("details").and_then(|d| d.get("context_length")).and_then(|c| c.as_u64());
            if let (Some(name), Some(ctx)) = (name, ctx) {
                out.insert(name.to_string(), ctx);
            }
        }
    }
    out
}

#[tauri::command]
pub async fn ai_list_models(_app: AppHandle, base_url: String, provider: String) -> Result<Vec<ModelInfo>, String> {
    let key = read_api_key(&provider);
    let validated = validate_base_url(&base_url)?;
    let url = format!("{}/models", validated);
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

    let ollama_ctx = if provider == "local" {
        fetch_ollama_context_lengths(&client, &validated).await
    } else {
        std::collections::HashMap::new()
    };

    let mut models = Vec::new();
    if let Some(data) = parsed.get("data").and_then(|d| d.as_array()) {
        for m in data {
            if let Some(id) = m.get("id").and_then(|i| i.as_str()) {
                let context_length = m.get("context_length")
                    .and_then(|c| c.as_u64())
                    .or_else(|| ollama_ctx.get(id).copied());
                models.push(ModelInfo { id: id.to_string(), context_length });
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
    provider: String,
) -> Result<String, String> {
    let key = read_api_key(&provider);
    let url = format!("{}/chat/completions", validate_base_url(&base_url)?);
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
    provider: String,
) -> Result<(), String> {
    let key = read_api_key(&provider);
    let url = format!("{}/chat/completions", validate_base_url(&base_url)?);
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

#[cfg(test)]
mod tests {
    use super::validate_base_url;

    #[test]
    fn accepts_https_any_host() {
        assert_eq!(
            validate_base_url("https://ollama.com/v1").unwrap(),
            "https://ollama.com/v1"
        );
    }

    #[test]
    fn trims_whitespace_and_trailing_slash() {
        assert_eq!(
            validate_base_url("  https://ollama.com/v1/  ").unwrap(),
            "https://ollama.com/v1"
        );
    }

    #[test]
    fn accepts_http_only_on_loopback() {
        assert!(validate_base_url("http://localhost:11434/v1").is_ok());
        assert!(validate_base_url("http://127.0.0.1:11434/v1").is_ok());
    }

    #[test]
    fn rejects_plain_http_to_remote_host() {
        // Would leak the bearer token in cleartext — must be refused.
        assert!(validate_base_url("http://evil.example.com/v1").is_err());
    }

    #[test]
    fn rejects_non_http_schemes() {
        assert!(validate_base_url("file:///etc/passwd").is_err());
        assert!(validate_base_url("ftp://host/x").is_err());
    }

    #[test]
    fn rejects_garbage_and_empty() {
        assert!(validate_base_url("not a url").is_err());
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("   ").is_err());
    }
}
