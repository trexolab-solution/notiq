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

// ── thinking models ──────────────────────────────────────────────────────────
//
// A "thinking" (reasoning) model spends `max_tokens` on hidden thought before it writes anything. The editor's
// features ask for short answers (30–700 tokens), which thought alone can use up: the reply then comes back
// empty. So a short request is tried as asked (with thinking switched off where the API has a switch), and if
// nothing comes back, once more with room to think.

/// A request with at least this budget (the chat) already has room to think.
const ROOMY_BUDGET: u32 = 4096;
/// Extra tokens for the second try of a short request.
const THINKING_HEADROOM: u32 = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Attempt {
    max_tokens: u32,
    /// Ask the model not to think (OpenRouter's `reasoning.effort`). A model that must think refuses with a 400.
    no_thinking: bool,
}

fn attempts(provider: &str, max_tokens: u32) -> Vec<Attempt> {
    let first = Attempt { max_tokens, no_thinking: false };
    if max_tokens >= ROOMY_BUDGET {
        return vec![first];
    }
    vec![
        Attempt { no_thinking: provider == "openrouter", ..first },
        Attempt { max_tokens: max_tokens + THINKING_HEADROOM, no_thinking: false },
    ]
}

/// What one completion request is made of.
struct Request<'a> {
    url: String,
    key: String,
    model: &'a str,
    messages: &'a [ChatMessage],
    temperature: f32,
}

impl Request<'_> {
    fn body(&self, a: Attempt, stream: bool) -> serde_json::Value {
        let mut body = serde_json::json!({
            "model": self.model,
            "messages": self.messages,
            "max_tokens": a.max_tokens,
            "temperature": self.temperature,
            "stream": stream,
        });
        if a.no_thinking {
            body["reasoning"] = serde_json::json!({ "effort": "none" });
        }
        body
    }

    /// Sends one attempt; an HTTP error comes back as `"<status>|<body>"`.
    async fn send(&self, client: &reqwest::Client, a: Attempt, stream: bool) -> Result<reqwest::Response, String> {
        let mut req = client.post(&self.url).json(&self.body(a, stream));
        if !self.key.is_empty() {
            req = req.bearer_auth(&self.key);
        }
        let resp = req.send().await.map_err(|e| format!("network|{}", e))?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("{}|{}", status.as_u16(), snippet(&text)));
        }
        Ok(resp)
    }
}

/// A 400 for an attempt that asked for no thinking: the model may be refusing exactly that.
fn refused_no_thinking(a: Attempt, err: &str) -> bool {
    a.no_thinking && err.starts_with("400|")
}

/// An error some providers send with a success status, as `"<code>|<message>"`.
fn body_error(v: &serde_json::Value) -> Option<String> {
    let e = v.get("error").filter(|e| !e.is_null())?;
    let message = e.get("message").and_then(|m| m.as_str()).map(str::to_string).unwrap_or_else(|| e.to_string());
    let code = e.get("code").and_then(|c| c.as_u64()).map(|c| c.to_string()).unwrap_or_else(|| "provider".into());
    Some(format!("{code}|{}", snippet(&message)))
}

/// The error for an answer with no text, saying why when the provider does.
fn empty_answer(finish: Option<&str>) -> String {
    format!("empty|{}", finish.unwrap_or(""))
}

async fn complete(client: &reqwest::Client, request: &Request<'_>, plan: &[Attempt]) -> Result<String, String> {
    let mut failure = empty_answer(None);
    for (i, a) in plan.iter().copied().enumerate() {
        let more = i + 1 < plan.len();
        let resp = match request.send(client, a, false).await {
            Ok(r) => r,
            Err(e) if more && refused_no_thinking(a, &e) => continue,
            Err(e) => return Err(e),
        };
        let text = resp.text().await.unwrap_or_default();
        let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("parse|{}", e))?;
        if let Some(e) = body_error(&parsed) {
            return Err(e);
        }
        let choice = parsed.get("choices").and_then(|c| c.get(0));
        let content = choice
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        if !content.trim().is_empty() {
            return Ok(content.to_string());
        }
        failure = empty_answer(choice.and_then(|c| c.get("finish_reason")).and_then(|r| r.as_str()));
    }
    Err(failure)
}

/// Reads one streamed reply, handing each piece of text to `on_token`. Returns whether any text came, and the
/// last `finish_reason`.
async fn read_stream(resp: reqwest::Response, on_token: &mut (dyn FnMut(&str) + Send)) -> Result<(bool, Option<String>), String> {
    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut last_finish: Option<String> = None;
    let mut wrote = false;

    while let Some(item) = stream.next().await {
        let chunk = item.map_err(|e| format!("stream|{}", e))?;
        buffer.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(pos) = buffer.find("\n\n") {
            let line = buffer[..pos].to_string();
            buffer = buffer[pos + 2..].to_string();

            let Some(data) = line.strip_prefix("data: ") else { continue };
            if data == "[DONE]" {
                return Ok((wrote, last_finish));
            }
            let Ok(parsed) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            if let Some(e) = body_error(&parsed) {
                return Err(e);
            }
            let choice = parsed.get("choices").and_then(|c| c.get(0));
            if let Some(reason) = choice.and_then(|c| c.get("finish_reason")).and_then(|r| r.as_str()) {
                last_finish = Some(reason.to_string());
            }
            if let Some(token) = choice
                .and_then(|c| c.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|t| t.as_str())
                .filter(|t| !t.is_empty())
            {
                wrote = true;
                on_token(token);
            }
        }
    }
    // The stream ended without an explicit [DONE].
    Ok((wrote, last_finish))
}

/// Like [`complete`], streamed. A second try only happens while nothing has been written.
async fn complete_stream(
    client: &reqwest::Client,
    request: &Request<'_>,
    plan: &[Attempt],
    on_token: &mut (dyn FnMut(&str) + Send),
) -> Result<Option<String>, String> {
    let mut failure = empty_answer(None);
    for (i, a) in plan.iter().copied().enumerate() {
        let more = i + 1 < plan.len();
        let resp = match request.send(client, a, true).await {
            Ok(r) => r,
            Err(e) if more && refused_no_thinking(a, &e) => continue,
            Err(e) => return Err(e),
        };
        let (wrote, finish) = read_stream(resp, on_token).await?;
        if wrote {
            return Ok(finish);
        }
        failure = empty_answer(finish.as_deref());
    }
    Err(failure)
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
    let request = Request {
        url: format!("{}/chat/completions", validate_base_url(&base_url)?),
        key: read_api_key(&provider),
        model: &model,
        messages: &messages,
        temperature,
    };
    complete(&http_client()?, &request, &attempts(&provider, max_tokens)).await
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
    let request = Request {
        url: format!("{}/chat/completions", validate_base_url(&base_url)?),
        key: read_api_key(&provider),
        model: &model,
        messages: &messages,
        temperature,
    };
    let emit = |token: String, is_final: bool, finish_reason: Option<String>| {
        app.emit("ai-stream-token", StreamPayload { request_id: request_id.clone(), token, is_final, finish_reason }).ok();
    };
    let mut on_token = |token: &str| emit(token.to_string(), false, None);
    let finish = complete_stream(&http_client()?, &request, &attempts(&provider, max_tokens), &mut on_token).await?;
    emit(String::new(), true, finish);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A one-reply-per-connection HTTP server: answers with `replies` in order and keeps each request's JSON body.
    async fn server(replies: Vec<(u16, String)>) -> (String, Arc<Mutex<Vec<serde_json::Value>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://127.0.0.1:{}/chat/completions", listener.local_addr().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            for (status, body) in replies {
                let (mut s, _) = listener.accept().await.unwrap();
                let mut got = Vec::new();
                let mut buf = [0u8; 4096];
                loop {
                    let n = s.read(&mut buf).await.unwrap();
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got).into_owned();
                    let Some((head, sent)) = text.split_once("\r\n\r\n") else { continue };
                    let want: usize = head.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())).unwrap_or(0);
                    if sent.len() >= want || n == 0 {
                        log.lock().unwrap().push(serde_json::from_str(sent).unwrap());
                        break;
                    }
                }
                let reply = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                s.write_all(reply.as_bytes()).await.unwrap();
                let _ = s.shutdown().await;
            }
        });
        (url, seen)
    }

    fn request<'a>(url: String, messages: &'a [ChatMessage]) -> Request<'a> {
        Request { url, key: String::new(), model: "m", messages, temperature: 0.2 }
    }

    fn answer(content: &str, finish: &str) -> String {
        serde_json::json!({ "choices": [{ "message": { "content": content }, "finish_reason": finish }] }).to_string()
    }

    fn client() -> reqwest::Client { reqwest::Client::builder().no_proxy().build().unwrap() }

    #[test]
    fn a_short_request_gets_a_second_try_with_room_to_think_and_the_chat_does_not() {
        let plan = attempts("openrouter", 60);
        assert_eq!(plan, vec![Attempt { max_tokens: 60, no_thinking: true }, Attempt { max_tokens: 2108, no_thinking: false }]);
        assert!(!attempts("local", 60)[0].no_thinking, "only OpenRouter has the switch");
        assert_eq!(attempts("openrouter", 4096), vec![Attempt { max_tokens: 4096, no_thinking: false }]);
    }

    #[tokio::test]
    async fn an_empty_answer_is_asked_again_with_more_tokens() {
        let (url, seen) = server(vec![(200, answer("", "length")), (200, answer("Summary", "stop"))]).await;
        let out = complete(&client(), &request(url, &[]), &attempts("openrouter", 30)).await;
        assert_eq!(out.as_deref(), Ok("Summary"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0]["reasoning"]["effort"], "none");
        assert_eq!(seen[1]["max_tokens"], 2078);
        assert!(seen[1].get("reasoning").is_none());
    }

    #[tokio::test]
    async fn a_model_that_must_think_is_asked_without_the_switch_and_a_good_first_answer_is_kept() {
        let (url, seen) = server(vec![(400, "reasoning is mandatory".into()), (200, answer("ok", "stop"))]).await;
        assert_eq!(complete(&client(), &request(url, &[]), &attempts("openrouter", 60)).await.as_deref(), Ok("ok"));
        assert_eq!(seen.lock().unwrap().len(), 2);
        let (url, seen) = server(vec![(200, answer("first", "stop"))]).await;
        assert_eq!(complete(&client(), &request(url, &[]), &attempts("openrouter", 60)).await.as_deref(), Ok("first"));
        assert_eq!(seen.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn failures_are_reported_instead_of_an_empty_answer() {
        let (url, _) = server(vec![(200, answer("", "length")), (200, answer("  ", "length"))]).await;
        assert_eq!(complete(&client(), &request(url, &[]), &attempts("local", 60)).await, Err("empty|length".into()));
        let (url, _) = server(vec![(429, "slow down".into())]).await;
        assert_eq!(complete(&client(), &request(url, &[]), &attempts("openrouter", 60)).await, Err("429|slow down".into()));
        let (url, _) = server(vec![(200, r#"{"error":{"code":402,"message":"no credits"}}"#.into())]).await;
        assert_eq!(complete(&client(), &request(url, &[]), &attempts("openrouter", 60)).await, Err("402|no credits".into()));
    }

    #[tokio::test]
    async fn a_stream_with_no_text_is_asked_again_and_a_mid_stream_error_is_reported() {
        let thought = "data: {\"choices\":[{\"delta\":{\"reasoning\":\"hmm\",\"content\":\"\"},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n";
        let text = ": PROCESSING\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"Hi\"}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
        let (url, seen) = server(vec![(200, thought.into()), (200, text.into())]).await;
        let mut got = String::new();
        let finish = complete_stream(&client(), &request(url, &[]), &attempts("openrouter", 100), &mut |t: &str| got.push_str(t)).await;
        assert_eq!((got.as_str(), finish), ("Hi", Ok(Some("stop".into()))));
        assert_eq!(seen.lock().unwrap().len(), 2);
        let (url, _) = server(vec![(200, "data: {\"error\":{\"message\":\"upstream failed\"}}\n\n".into())]).await;
        let out = complete_stream(&client(), &request(url, &[]), &attempts("openrouter", 100), &mut |_: &str| {}).await;
        assert_eq!(out, Err("provider|upstream failed".into()));
    }

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
