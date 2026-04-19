//! Tauri backend for the memex GUI. Exposes a minimal set of commands the
//! React frontend can invoke to read/write nodes on the memex-fs mount,
//! plus an `ask_stream` command that compiles graph context and streams
//! an LLM response back via Tauri events.

mod context;
mod llm;
mod mount;

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

use chrono::Local;
use serde::Serialize;
use tauri::AppHandle;

use crate::llm::{ChatMessage, ImageInput};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crate::mount::{
    derive_label, humanize_id, mount_path, node_dir, read_mime, require_mount, validate_node_id,
};

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------
// Node read / write
// ---------------------------------------------------------------

#[tauri::command]
fn read_node(id: String) -> Result<String, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let path = node_dir(&mount, &id).join("content");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
}

#[tauri::command]
fn write_node(id: String, content: String) -> Result<(), String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let dir = node_dir(&mount, &id);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    }
    let content_path = dir.join("content");
    fs::write(&content_path, content)
        .map_err(|e| format!("write {}: {}", content_path.display(), e))
}

#[tauri::command]
fn today_note_id() -> String {
    format!("daily:{}", Local::now().format("%Y-%m-%d"))
}

/// Read the raw bytes of a node's content. Used by the frontend to
/// render images/videos/PDFs that were ingested as binary nodes.
/// Returns a Vec<u8> that Tauri serializes to a JS ArrayBuffer-ish
/// number array; the caller wraps it in a Blob for `<img>` / `<video>`.
#[tauri::command]
fn read_node_bytes(id: String) -> Result<Vec<u8>, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let path = node_dir(&mount, &id).join("content");
    fs::read(&path).map_err(|e| format!("read {}: {}", path.display(), e))
}

/// Return the MIME type recorded in meta.json for a node, or the empty
/// string if none is set (text-native nodes typically omit it).
#[tauri::command]
fn read_node_mime(id: String) -> Result<String, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    Ok(read_mime(&mount, &id).unwrap_or_default())
}

/// Ingest arbitrary bytes as a new node. Hashes the content with
/// SHA-256, picks an id-prefix from the MIME (img / video / audio /
/// pdf / file), writes content + meta.json with the MIME and optional
/// alt text. Returns the newly-created id so the caller can embed a
/// `memex://{id}` URL in document bodies.
#[tauri::command]
fn create_binary_node(
    bytes: Vec<u8>,
    mime: String,
    alt: Option<String>,
) -> Result<String, String> {
    let mount = require_mount()?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hex = hex::encode(hasher.finalize());
    let short = &hex[..16];
    let prefix = mime_to_id_prefix(&mime);
    let id = format!("{}:{}", prefix, short);

    let dir = node_dir(&mount, &id);
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    }
    // Idempotent: if content already exists (same hash, same bytes), skip
    // the rewrite so we don't churn the commit log.
    let content_path = dir.join("content");
    if !content_path.exists() {
        fs::write(&content_path, &bytes)
            .map_err(|e| format!("write {}: {}", content_path.display(), e))?;
    }
    let mut meta = serde_json::Map::new();
    meta.insert("mime".into(), serde_json::Value::String(mime));
    meta.insert(
        "size_bytes".into(),
        serde_json::Value::Number((bytes.len() as u64).into()),
    );
    if let Some(a) = alt {
        let trimmed = a.trim();
        if !trimmed.is_empty() {
            meta.insert("alt".into(), serde_json::Value::String(trimmed.to_string()));
        }
    }
    let meta_path = dir.join("meta.json");
    // Only write meta.json if we just created the node; preserving an
    // existing meta.json is important because the user may have added
    // fields (captions, dimensions).
    if !meta_path.exists() {
        let json = serde_json::to_string_pretty(&meta)
            .map_err(|e| format!("serialize meta: {}", e))?;
        fs::write(&meta_path, json).map_err(|e| format!("write meta: {}", e))?;
    }

    Ok(id)
}

fn mime_to_id_prefix(mime: &str) -> &'static str {
    let m = mime.to_ascii_lowercase();
    if m.starts_with("image/") {
        "img"
    } else if m.starts_with("video/") {
        "video"
    } else if m.starts_with("audio/") {
        "audio"
    } else if m == "application/pdf" {
        "pdf"
    } else {
        "file"
    }
}

#[tauri::command]
fn read_node_type(id: String) -> Result<String, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let path = node_dir(&mount, &id).join("type");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
}

// ---------------------------------------------------------------
// Types / listings
// ---------------------------------------------------------------

#[derive(Serialize)]
struct TypeInfo {
    name: String,
    count: usize,
}

#[tauri::command]
fn list_types() -> Result<Vec<TypeInfo>, String> {
    let mount = require_mount()?;
    let types_dir = mount.join("types");
    let mut types = Vec::new();
    let entries =
        fs::read_dir(&types_dir).map_err(|e| format!("read {}: {}", types_dir.display(), e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let count = fs::read_dir(entry.path()).map(|it| it.count()).unwrap_or(0);
        types.push(TypeInfo { name, count });
    }
    types.sort_by(|a, b| match b.count.cmp(&a.count) {
        Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });
    Ok(types)
}

#[tauri::command]
fn list_nodes_by_type(type_name: String) -> Result<Vec<String>, String> {
    if type_name.contains('/') || type_name.contains("..") {
        return Err(format!("invalid type name: {}", type_name));
    }
    let mount = require_mount()?;
    let dir = mount.join("types").join(&type_name);
    let entries = fs::read_dir(&dir).map_err(|e| format!("read {}: {}", dir.display(), e))?;
    let mut ids: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    if type_name.eq_ignore_ascii_case("daily") {
        ids.sort_by(|a, b| b.cmp(a));
    } else {
        ids.sort();
    }
    Ok(ids)
}

// ---------------------------------------------------------------
// Links / neighbors
// ---------------------------------------------------------------

#[derive(Serialize)]
struct LinkInfo {
    peer: String,
    link_type: String,
}

fn parse_link_entry(name: &str) -> Option<(String, String)> {
    let idx = name.find(':')?;
    Some((name[..idx].to_string(), name[idx + 1..].to_string()))
}

#[tauri::command]
fn read_outgoing_links(id: String) -> Result<Vec<LinkInfo>, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let dir = node_dir(&mount, &id).join("links");
    read_link_entries(&dir)
}

#[tauri::command]
fn read_backlinks(id: String) -> Result<Vec<LinkInfo>, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let dir = node_dir(&mount, &id).join("backlinks");
    read_link_entries(&dir)
}

fn read_link_entries(dir: &Path) -> Result<Vec<LinkInfo>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {}", dir.display(), e)),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some((link_type, peer)) = parse_link_entry(&name) {
            out.push(LinkInfo { peer, link_type });
        }
    }
    out.sort_by(|a, b| a.peer.cmp(&b.peer));
    Ok(out)
}

/// Search the mount via memex-fs's `/search/{query}/` view. Returns the
/// ordered list of matching node IDs. Whitespace in the query is fine —
/// memex-fs tokenizes it the same way it indexed the content.
#[tauri::command]
fn search_nodes(query: String) -> Result<Vec<String>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    if trimmed.contains('/') || trimmed.contains("..") {
        return Err("invalid search query".into());
    }
    let mount = require_mount()?;
    let dir = mount.join("search").join(trimmed);
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {}", dir.display(), e)),
    };
    Ok(entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
fn read_neighbors(id: String) -> Result<Vec<String>, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let dir = node_dir(&mount, &id).join("neighbors");
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {}", dir.display(), e)),
    };
    Ok(entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect())
}

// ---------------------------------------------------------------
// Labels
// ---------------------------------------------------------------

#[tauri::command]
fn read_node_labels(ids: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mount = require_mount()?;
    let mut out = HashMap::with_capacity(ids.len());
    for id in ids {
        if validate_node_id(&id).is_err() {
            out.insert(id.clone(), humanize_id(&id));
            continue;
        }
        let label = derive_label(&mount, &id);
        out.insert(id, label);
    }
    Ok(out)
}

// ---------------------------------------------------------------
// Mount status
// ---------------------------------------------------------------

#[derive(Serialize)]
struct MountStatus {
    path: String,
    mounted: bool,
}

#[tauri::command]
fn mount_status() -> MountStatus {
    let path = mount_path();
    MountStatus {
        mounted: path.join("nodes").is_dir(),
        path: path.to_string_lossy().into_owned(),
    }
}

// ---------------------------------------------------------------
// Chat
// ---------------------------------------------------------------

/// Compile the prompt context for a node without sending anything to
/// an LLM. The frontend uses this to show "what got sent" so users can
/// audit the conversation.
#[tauri::command]
fn compile_node_context(id: String) -> Result<String, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    Ok(context::compile(&mount, &id))
}

/// Ask the LLM a question about a node. The given user/assistant history
/// is preserved; the backend prepends a system prompt and a fresh
/// context block for the node. Responses stream via "chat-chunk" events;
/// "chat-done" fires on completion and "chat-error" on failure.
#[tauri::command]
async fn ask_stream(
    app: AppHandle,
    node_id: String,
    history: Vec<ChatMessage>,
    question: String,
) -> Result<(), String> {
    validate_node_id(&node_id)?;
    let mount = require_mount()?;
    let ctx = context::compile(&mount, &node_id);

    let system = ChatMessage::text("system", build_system_prompt());
    let primer_text = format!("Context about the node I'm looking at:\n\n{}", ctx);

    // If the current node IS an image, attach its bytes as a vision
    // input alongside the text context. Future refinement: scan the
    // context for embedded `memex://` image refs and include those
    // too. For now, only the current node.
    let images = collect_current_image(&mount, &node_id);
    let primer = if images.is_empty() {
        ChatMessage::text("user", primer_text)
    } else {
        ChatMessage::text_and_images("user", primer_text, images)
    };
    let primer_ack = ChatMessage::text(
        "assistant",
        "Got it. I'll answer your questions using this context.",
    );

    let mut messages = vec![system, primer, primer_ack];
    messages.extend(history);
    messages.push(ChatMessage::text("user", question));

    tauri::async_runtime::spawn(async move {
        let result = llm::stream_chat(app.clone(), messages, None).await;
        use tauri::Emitter;
        match result {
            Ok(()) => {
                let _ = app.emit("chat-done", ());
            }
            Err(e) => {
                let _ = app.emit("chat-error", e);
            }
        }
    });
    Ok(())
}

/// If the node is an image type (MIME starts with `image/`), load its
/// bytes and pack them into a data URL suitable for OpenAI's vision
/// input. Non-image nodes yield an empty vector. Failures return an
/// empty vector too — vision is best-effort; chat still works without.
fn collect_current_image(mount: &std::path::Path, node_id: &str) -> Vec<ImageInput> {
    let Some(mime) = read_mime(mount, node_id) else {
        return Vec::new();
    };
    if !mime.starts_with("image/") {
        return Vec::new();
    }
    let Ok(bytes) = fs::read(node_dir(mount, node_id).join("content")) else {
        return Vec::new();
    };
    let b64 = B64.encode(bytes);
    vec![ImageInput {
        data_url: format!("data:{};base64,{}", mime, b64),
    }]
}

fn build_system_prompt() -> String {
    r#"You are a personal knowledge-graph assistant. The user is looking at a node in their
graph and is asking a question about it. You have been given:

- The current node's content and metadata
- Its backlinks (other nodes that reference it)
- Its outgoing links (what it references)
- Its top-ranked neighbors (multi-signal relevance from memex-fs)

Guidelines:
- Answer using the provided context when possible. When you draw on the
  context, mention nodes by their label so the user can recognize them.
- If the context is insufficient, say so and suggest which other nodes the
  user might explore — don't confabulate facts.
- Be concise by default. Use Markdown for structure only when it helps.
- When referencing a node, you can write [[id]] to let future tooling turn
  it into a live link.
"#
        .to_string()
}

// ---------------------------------------------------------------
// Run
// ---------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_node,
            write_node,
            today_note_id,
            read_node_type,
            read_node_bytes,
            read_node_mime,
            create_binary_node,
            read_node_labels,
            list_types,
            list_nodes_by_type,
            read_outgoing_links,
            read_backlinks,
            read_neighbors,
            search_nodes,
            mount_status,
            compile_node_context,
            ask_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
