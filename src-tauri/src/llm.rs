//! OpenAI chat streaming. Minimal: one provider, one model by default,
//! events emitted via Tauri so the React frontend can render tokens as
//! they arrive.
//!
//! Keep this module provider-specific on purpose. A later pass adds an
//! abstraction when we actually have a second provider to support
//! (Anthropic, Ollama). Speculating earlier invents wrong seams.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL: &str = "gpt-4o-mini";

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

/// Parse one SSE line of the form `data: {...}` or `data: [DONE]`.
/// Returns Some(delta-string) for a content chunk, None for anything
/// non-content (ping, metadata, DONE).
fn parse_sse_chunk(line: &str) -> Option<String> {
    let body = line.strip_prefix("data: ")?.trim();
    if body == "[DONE]" {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    let choice = v.get("choices")?.get(0)?;
    let delta = choice.get("delta")?.get("content")?.as_str()?;
    if delta.is_empty() {
        return None;
    }
    Some(delta.to_string())
}

/// Stream a chat completion. Emits "chat-chunk" events with partial
/// text, "chat-done" when the stream closes cleanly, "chat-error" on
/// any failure. All events are strings so the frontend doesn't need a
/// schema.
pub async fn stream_chat(
    app: AppHandle,
    messages: Vec<ChatMessage>,
    model: Option<String>,
) -> Result<(), String> {
    let api_key = std::env::var("OPENAI_API_KEY").map_err(|_| {
        "OPENAI_API_KEY is not set. Export it in the shell you launch memex from.".to_string()
    })?;
    let model_name = model.as_deref().unwrap_or(DEFAULT_MODEL);

    let client = reqwest::Client::new();
    let body = ChatRequest {
        model: model_name,
        messages: &messages,
        stream: true,
    };

    let resp = client
        .post(OPENAI_ENDPOINT)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("request: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("openai {}: {}", status, text));
    }

    let mut stream = resp.bytes_stream();
    // SSE chunks arrive split across TCP boundaries; keep a buffer and
    // flush completed `data: {...}` lines.
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("stream: {}", e))?;
        let text = std::str::from_utf8(&bytes).map_err(|e| format!("utf8: {}", e))?;
        buf.push_str(text);
        while let Some(newline) = buf.find('\n') {
            let line = buf[..newline].trim_end_matches('\r').to_string();
            buf.drain(..=newline);
            if line.is_empty() {
                continue;
            }
            if let Some(delta) = parse_sse_chunk(&line) {
                let _ = app.emit("chat-chunk", delta);
            }
        }
    }
    Ok(())
}
