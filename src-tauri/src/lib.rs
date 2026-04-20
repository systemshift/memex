//! Tauri backend for the memex GUI. Exposes a minimal set of commands the
//! React frontend can invoke to read/write nodes on the memex-fs mount,
//! plus an `ask_stream` command that compiles graph context and streams
//! an LLM response back via Tauri events.

mod context;
mod llm;
mod mount;

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet, VecDeque};
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

#[derive(Serialize)]
struct GraphNode {
    id: String,
    type_name: String,
    label: String,
    is_center: bool,
}

#[derive(Serialize)]
struct GraphEdge {
    source: String,
    target: String,
    link_type: String,
}

#[derive(Serialize)]
struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

/// Walk the graph outward from `center` to up to `hops` steps and
/// return a node/edge set suitable for a force-directed layout.
/// BFS expands through both outgoing and incoming links so the
/// returned neighborhood is the *connected component* visible from
/// the center (within the hop budget), not just a downstream tree.
///
/// Node budget defaults to 200 — a force graph above that becomes
/// a hairball anyway, and we'd rather cap than render forever.
#[tauri::command]
fn neighborhood_graph(center: String, hops: u32) -> Result<GraphData, String> {
    validate_node_id(&center)?;
    let mount = require_mount()?;

    const NODE_BUDGET: usize = 200;

    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<(String, u32)> = VecDeque::new();
    queue.push_back((center.clone(), 0));
    visited.insert(center.clone());

    // Dedup edges by (source, target, link_type) so a link that shows
    // up in both endpoints' dirs isn't rendered twice.
    let mut edge_set: HashSet<(String, String, String)> = HashSet::new();
    let mut edges: Vec<GraphEdge> = Vec::new();

    while let Some((id, depth)) = queue.pop_front() {
        if visited.len() >= NODE_BUDGET {
            break;
        }
        // Outgoing links — these are the authoritative edge records.
        for (link_type, peer) in list_link_entries(&mount, &id, "links") {
            let target = strip_block(&peer);
            let key = (id.clone(), target.clone(), link_type.clone());
            if edge_set.insert(key) {
                edges.push(GraphEdge {
                    source: id.clone(),
                    target: target.clone(),
                    link_type: link_type.clone(),
                });
            }
            if depth < hops && !visited.contains(&target) && visited.len() < NODE_BUDGET {
                visited.insert(target.clone());
                queue.push_back((target, depth + 1));
            }
        }
        // Backlinks — we only use these to discover neighbors (the
        // edge was already recorded on the source side above, or it
        // will be when we visit the source).
        for (_, peer) in list_link_entries(&mount, &id, "backlinks") {
            let source = strip_block(&peer);
            if depth < hops && !visited.contains(&source) && visited.len() < NODE_BUDGET {
                visited.insert(source.clone());
                queue.push_back((source, depth + 1));
            }
        }
    }

    // After BFS, any edge whose endpoints we didn't visit (because of
    // the node budget) should be dropped so the frontend doesn't get
    // dangling refs.
    edges.retain(|e| visited.contains(&e.source) && visited.contains(&e.target));

    let nodes: Vec<GraphNode> = visited
        .iter()
        .map(|id| {
            let type_name = fs::read_to_string(node_dir(&mount, id).join("type"))
                .unwrap_or_default()
                .trim()
                .to_string();
            GraphNode {
                id: id.clone(),
                type_name,
                label: derive_label(&mount, id),
                is_center: id == &center,
            }
        })
        .collect();

    Ok(GraphData { nodes, edges })
}

fn list_link_entries(mount: &Path, node_id: &str, sub: &str) -> Vec<(String, String)> {
    let dir = node_dir(mount, node_id).join(sub);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(idx) = name.find(':') {
            out.push((name[..idx].to_string(), name[idx + 1..].to_string()));
        }
    }
    out
}

fn strip_block(peer: &str) -> String {
    match peer.find('#') {
        Some(i) => peer[..i].to_string(),
        None => peer.to_string(),
    }
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

// ---------------------------------------------------------------
// Emergent clusters
// ---------------------------------------------------------------

#[derive(Serialize)]
struct ClusterInfo {
    id: String,
    members: Vec<String>,
}

/// Read every cluster memex-fs has surfaced at /emergent/clusters/.
/// Returns them ordered by size, largest first. A cluster is a
/// directory whose entries are symlinks to member node directories.
#[tauri::command]
fn list_clusters() -> Result<Vec<ClusterInfo>, String> {
    let mount = require_mount()?;
    let dir = mount.join("emergent").join("clusters");
    let entries = match fs::read_dir(&dir) {
        Ok(it) => it,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {}", dir.display(), e)),
    };
    let mut out: Vec<ClusterInfo> = Vec::new();
    for entry in entries.flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        let members_path = entry.path();
        let mut members: Vec<String> = Vec::new();
        if let Ok(mem_entries) = fs::read_dir(&members_path) {
            for m in mem_entries.flatten() {
                members.push(m.file_name().to_string_lossy().into_owned());
            }
        }
        members.sort();
        out.push(ClusterInfo { id, members });
    }
    out.sort_by(|a, b| b.members.len().cmp(&a.members.len()));
    Ok(out)
}

// ---------------------------------------------------------------
// Commit history / time-travel
// ---------------------------------------------------------------

#[derive(Serialize)]
struct CommitInfo {
    cid: String,
    timestamp: String,
    message: String,
    author: String,
}

#[derive(serde::Deserialize)]
struct CommitJson {
    #[serde(default)]
    parent: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    refs: HashMap<String, String>,
}

/// Walk the commit log newer-first and return the commits where the
/// given node's ref changed (including creation and deletion). This
/// is the per-node history surface the right-panel's History tab
/// renders. Limit caps how many log entries we scan; memex-fs
/// currently caps its FUSE log view at 64.
#[tauri::command]
fn list_node_history(id: String, limit: u32) -> Result<Vec<CommitInfo>, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let log_dir = mount.join("log");

    let head_cid = match fs::read_to_string(log_dir.join("HEAD")) {
        Ok(s) => s.trim().to_string(),
        Err(_) => return Ok(Vec::new()),
    };
    if head_cid.is_empty() || head_cid == "(none)" {
        return Ok(Vec::new());
    }

    let mut commits: Vec<CommitJson> = Vec::new();
    let cap = limit.min(64) as usize;
    for i in 0..cap {
        let path = log_dir.join(format!("{}", i));
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => break,
        };
        match serde_json::from_str::<CommitJson>(&raw) {
            Ok(c) => commits.push(c),
            Err(_) => break,
        }
    }
    if commits.is_empty() {
        return Ok(Vec::new());
    }

    // Derive each commit's own CID by chaining parents from HEAD.
    let mut cids: Vec<String> = Vec::with_capacity(commits.len());
    cids.push(head_cid);
    for c in &commits[..commits.len().saturating_sub(1)] {
        cids.push(c.parent.clone());
    }

    // Filter to commits where this node's ref changed vs the parent.
    let mut out: Vec<CommitInfo> = Vec::new();
    for i in 0..commits.len() {
        let this_ref = commits[i].refs.get(&id);
        let parent_ref = commits.get(i + 1).and_then(|p| p.refs.get(&id));
        let changed = match (this_ref, parent_ref) {
            (Some(a), Some(b)) => a != b,
            (Some(_), None) => true,  // created in this commit (as far as our window sees)
            (None, Some(_)) => true,  // deleted in this commit
            (None, None) => false,
        };
        if changed {
            out.push(CommitInfo {
                cid: cids[i].clone(),
                timestamp: commits[i].timestamp.clone(),
                message: commits[i].message.clone(),
                author: commits[i].author.clone(),
            });
        }
    }
    Ok(out)
}

/// Read a node's content as it existed at a specific commit. Delegates
/// to memex-fs's existing /at/{cid}/nodes/{id}/content view so we don't
/// reimplement snapshot logic in the GUI.
#[tauri::command]
fn read_node_at(id: String, commit_cid: String) -> Result<String, String> {
    validate_node_id(&id)?;
    if commit_cid.contains('/') || commit_cid.contains("..") || commit_cid.is_empty() {
        return Err(format!("invalid commit cid: {}", commit_cid));
    }
    let mount = require_mount()?;
    let path = mount
        .join("at")
        .join(&commit_cid)
        .join("nodes")
        .join(&id)
        .join("content");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
}

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
            neighborhood_graph,
            list_clusters,
            list_node_history,
            read_node_at,
            search_nodes,
            mount_status,
            compile_node_context,
            ask_stream,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
