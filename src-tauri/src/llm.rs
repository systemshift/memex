//! OpenAI chat streaming. Minimal: one provider, one model by default,
//! events emitted via Tauri so the React frontend can render tokens as
//! they arrive.
//!
//! Content shape: each ChatMessage carries an arbitrary JSON value so
//! we can send either a plain text prompt (string) or a multimodal
//! prompt (array of parts with text + image_url). OpenAI's chat API
//! accepts both forms on any single message.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

const OPENAI_ENDPOINT: &str = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL: &str = "gpt-4o-mini";

/// `content` is deliberately a raw JSON Value so we don't have to
/// maintain a tagged enum that mirrors OpenAI's shape. The frontend
/// always sends strings; the backend may upgrade one or more messages
/// to multimodal arrays before shipping the request.
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
}

impl ChatMessage {
    pub fn text(role: &str, s: impl Into<String>) -> Self {
        Self {
            role: role.to_string(),
            content: Value::String(s.into()),
        }
    }

    /// A user message that mixes a text prompt with one or more image
    /// references. Used to pass an image node's bytes into the prompt
    /// so a vision-capable model can see it.
    pub fn text_and_images(role: &str, text: String, images: Vec<ImageInput>) -> Self {
        let mut parts: Vec<Value> = Vec::with_capacity(1 + images.len());
        parts.push(serde_json::json!({ "type": "text", "text": text }));
        for img in images {
            parts.push(serde_json::json!({
                "type": "image_url",
                "image_url": { "url": img.data_url }
            }));
        }
        Self {
            role: role.to_string(),
            content: Value::Array(parts),
        }
    }
}

pub struct ImageInput {
    pub data_url: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: &'a [ChatMessage],
    stream: bool,
}

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
