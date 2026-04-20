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
use std::sync::Mutex;

use chrono::Local;
use serde::Serialize;
use tauri::AppHandle;

use crate::llm::{ChatMessage, ImageInput};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use crate::mount::{
    derive_label, humanize_id, mount_path, node_dir, read_meta, read_mime, require_mount,
    validate_node_id,
};

use sha2::{Digest, Sha256};

// ---------------------------------------------------------------
// Node read / write
// ---------------------------------------------------------------

#[tauri::command]
fn read_node(id: String) -> Result<String, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    // Auto-sync: if this node tracks an external file and it's text,
    // pull from the source when its mtime has moved past what we've
    // stored. Silent no-op for non-synced nodes (the common case).
    sync_from_source_if_stale(&mount, &id);
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
    fs::write(&content_path, &content)
        .map_err(|e| format!("write {}: {}", content_path.display(), e))?;
    // Write-back: for text nodes tracking an external path, propagate
    // the new bytes to that path so external editors see the change.
    // Failures are swallowed — source may have been moved, renamed,
    // or permission-changed — node state itself is already saved.
    write_back_to_source_if_text(&mount, &id, content.as_bytes());
    Ok(())
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

/// Return the whole meta.json as a JSON object. Used by the file
/// viewer to render basename / MIME / size / extracted_text without
/// making four round-trips.
#[tauri::command]
fn read_node_meta_json(id: String) -> Result<serde_json::Value, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let path = node_dir(&mount, &id).join("meta.json");
    match fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("parse meta: {}", e)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("read {}: {}", path.display(), e)),
    }
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
    } else if m == "application/epub+zip" {
        "book"
    } else if m == "text/markdown" || m == "text/x-markdown" {
        "doc"
    } else if m == "text/plain" {
        "note"
    } else if m.starts_with("text/x-") || m == "text/javascript" || m == "text/typescript" {
        "code"
    } else if m == "application/json" || m == "application/yaml" || m == "text/csv" {
        "data"
    } else {
        "file"
    }
}

// ---------------------------------------------------------------
// External file ingest + bidirectional sync
// ---------------------------------------------------------------

/// Ingest a single file or walk a directory and ingest each file
/// inside. Returns the node ids created or reused (content-addressed,
/// so re-ingesting the same bytes produces the same id and dedups).
///
/// Text files get their bytes inlined AND their `source_path` recorded
/// so subsequent reads pull fresh content and writes propagate back.
/// Binary files are fully inlined for integrity; their `source_path`
/// is a breadcrumb — edits don't write back, and an external change
/// produces a new node id on the next ingest (old version preserved).
#[tauri::command]
fn ingest_path(path: String, recursive: bool) -> Result<Vec<String>, String> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("path not found: {}", path));
    }
    let mount = require_mount()?;

    if p.is_file() {
        Ok(vec![ingest_single_file(&mount, &p)?])
    } else if p.is_dir() {
        let mut out: Vec<String> = Vec::new();
        walk_and_ingest(&mount, &p, recursive, &mut out);
        Ok(out)
    } else {
        Err(format!("not a file or directory: {}", path))
    }
}

fn walk_and_ingest(
    mount: &Path,
    dir: &Path,
    recursive: bool,
    out: &mut Vec<String>,
) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // Skip hidden files and typical noise.
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if name.starts_with('.') {
                continue;
            }
        }
        if path.is_dir() && recursive {
            walk_and_ingest(mount, &path, recursive, out);
        } else if path.is_file() {
            if let Ok(id) = ingest_single_file(mount, &path) {
                out.push(id);
            }
            // Unreadable / oversized / permission-denied files are
            // silently skipped so a single bad file can't abort a
            // 500-file import.
        }
    }
}

/// Ingest one file. Returns the content-addressed node id.
fn ingest_single_file(mount: &Path, path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("read {}: {}", path.display(), e))?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hex = hex::encode(hasher.finalize());
    let short = &hex[..16];

    // MIME inference: ext hint first, then content sniff as fallback.
    let mime = mime_from_extension(path).unwrap_or_else(|| {
        if is_text_content(&bytes) {
            "text/plain".to_string()
        } else {
            "application/octet-stream".to_string()
        }
    });
    let is_text = is_text_content(&bytes) && !mime.starts_with("image/") && !mime.starts_with("video/");

    let prefix = mime_to_id_prefix(&mime);
    let id = format!("{}:{}", prefix, short);

    let dir = node_dir(mount, &id);
    let is_new = !dir.exists();
    if is_new {
        fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    }

    // Content: write unconditionally on first ingest; skip if already
    // present (same hash means same bytes).
    let content_path = dir.join("content");
    if !content_path.exists() {
        fs::write(&content_path, &bytes).map_err(|e| format!("write content: {}", e))?;
    }

    // meta.json — record the source breadcrumb and sync state. Merge
    // with existing meta so a re-ingest of the same file updates
    // source_path / mtime without clobbering user-added fields.
    let mut desired_meta = serde_json::Map::new();
    desired_meta.insert(
        "mime".into(),
        serde_json::Value::String(mime.clone()),
    );
    desired_meta.insert(
        "size_bytes".into(),
        serde_json::Value::Number((bytes.len() as u64).into()),
    );
    desired_meta.insert(
        "source_path".into(),
        serde_json::Value::String(path.to_string_lossy().into_owned()),
    );
    desired_meta.insert(
        "external_mtime".into(),
        serde_json::Value::Number(source_mtime_secs(path).unwrap_or(0).into()),
    );
    desired_meta.insert(
        "external_hash".into(),
        serde_json::Value::String(format!("sha256:{}", hex)),
    );
    desired_meta.insert("is_text".into(), serde_json::Value::Bool(is_text));
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        desired_meta.insert(
            "basename".into(),
            serde_json::Value::String(name.to_string()),
        );
    }

    // For binary formats where we have a reliable text extractor, pull
    // the plaintext out so the node becomes readable, searchable, and
    // chat-queryable. Only the common case (PDF) for now.
    if let Some(text) = try_extract_text(path, &mime) {
        desired_meta.insert(
            "extracted_text".into(),
            serde_json::Value::String(text),
        );
    }

    let meta_path = dir.join("meta.json");
    let merged: serde_json::Map<String, serde_json::Value> = if meta_path.exists() {
        let mut prev: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(&fs::read_to_string(&meta_path).unwrap_or_default())
                .unwrap_or_default();
        for (k, v) in desired_meta {
            prev.insert(k, v);
        }
        prev
    } else {
        desired_meta
    };
    let json = serde_json::to_string_pretty(&merged).map_err(|e| format!("serialize meta: {}", e))?;
    fs::write(&meta_path, json).map_err(|e| format!("write meta: {}", e))?;

    Ok(id)
}

/// Basic text-or-binary heuristic: sample the first 8 KB, reject on
/// any null byte (binary marker) or invalid UTF-8.
fn is_text_content(bytes: &[u8]) -> bool {
    let sample_len = bytes.len().min(8192);
    let sample = &bytes[..sample_len];
    if sample.contains(&0) {
        return false;
    }
    std::str::from_utf8(sample).is_ok()
}

/// Guess a MIME from the file extension. Missing extensions / unknown
/// extensions return None so the caller can fall back to content-sniff.
fn mime_from_extension(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    Some(
        match ext.as_str() {
            "md" | "markdown" => "text/markdown",
            "txt" | "log" => "text/plain",
            "json" => "application/json",
            "yaml" | "yml" => "application/yaml",
            "csv" => "text/csv",
            "rs" => "text/x-rust",
            "ts" | "tsx" => "text/typescript",
            "js" | "jsx" | "mjs" | "cjs" => "text/javascript",
            "py" => "text/x-python",
            "go" => "text/x-go",
            "java" => "text/x-java",
            "c" | "h" => "text/x-c",
            "cpp" | "cc" | "hpp" => "text/x-c++",
            "rb" => "text/x-ruby",
            "sh" | "bash" | "zsh" => "text/x-shellscript",
            "html" | "htm" => "text/html",
            "css" => "text/css",
            "xml" => "application/xml",
            "pdf" => "application/pdf",
            "epub" => "application/epub+zip",
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            "mp4" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "flac" => "audio/flac",
            "ogg" => "audio/ogg",
            "zip" => "application/zip",
            _ => return None,
        }
        .to_string(),
    )
}

/// Opportunistic text extraction for binary formats. Shells out to
/// well-known CLI tools — no new Rust dependencies. If the tool
/// isn't installed, or extraction fails, returns None and the node
/// is still usable (just without preview text).
///
/// Output is capped at ~50 000 chars so meta.json doesn't grow
/// unboundedly for a 500-page book.
fn try_extract_text(path: &Path, mime: &str) -> Option<String> {
    let max_chars = 50_000;
    match mime {
        "application/pdf" => run_pdftotext(path, max_chars),
        _ => None,
    }
}

fn run_pdftotext(path: &Path, max_chars: usize) -> Option<String> {
    use std::process::Command;
    let output = Command::new("pdftotext")
        .arg("-enc")
        .arg("UTF-8")
        .arg("-nopgbrk")
        .arg(path)
        .arg("-") // write to stdout
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= max_chars {
        Some(chars.into_iter().collect())
    } else {
        let head: String = chars.iter().take(max_chars).collect();
        Some(format!("{}\n\n…[truncated]", head))
    }
}

fn source_mtime_secs(path: &Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// If the node is text + has a source_path + the source mtime has
/// advanced past what we've stored, re-read the source and update the
/// node's content + meta. Silent no-op for every other case.
fn sync_from_source_if_stale(mount: &Path, id: &str) {
    let Some(meta) = read_meta(mount, id) else {
        return;
    };
    let is_text = meta
        .get("is_text")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !is_text {
        return;
    }
    let Some(source_str) = meta.get("source_path").and_then(|v| v.as_str()) else {
        return;
    };
    let source = std::path::PathBuf::from(source_str);
    let Some(current_mtime) = source_mtime_secs(&source) else {
        return; // missing / unreadable — don't clobber local content
    };
    let stored_mtime = meta
        .get("external_mtime")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if current_mtime <= stored_mtime {
        return;
    }

    let Ok(bytes) = fs::read(&source) else {
        return;
    };
    let content_path = node_dir(mount, id).join("content");
    let _ = fs::write(&content_path, &bytes);

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let hex = hex::encode(hasher.finalize());

    let meta_path = node_dir(mount, id).join("meta.json");
    if let Ok(existing) = fs::read_to_string(&meta_path) {
        if let Ok(mut prev) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&existing)
        {
            prev.insert(
                "external_mtime".into(),
                serde_json::Value::Number(current_mtime.into()),
            );
            prev.insert(
                "external_hash".into(),
                serde_json::Value::String(format!("sha256:{}", hex)),
            );
            prev.insert(
                "size_bytes".into(),
                serde_json::Value::Number((bytes.len() as u64).into()),
            );
            if let Ok(json) = serde_json::to_string_pretty(&prev) {
                let _ = fs::write(&meta_path, json);
            }
        }
    }
}

/// Mirror a node's new content back to its tracked source_path when
/// it's text. Silent no-op for binary nodes, untracked nodes, or
/// missing sources (letting the user delete/rename external files
/// without the app exploding).
fn write_back_to_source_if_text(mount: &Path, id: &str, new_bytes: &[u8]) {
    let Some(meta) = read_meta(mount, id) else {
        return;
    };
    let is_text = meta
        .get("is_text")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !is_text {
        return;
    }
    let Some(source_str) = meta.get("source_path").and_then(|v| v.as_str()) else {
        return;
    };
    let source = std::path::PathBuf::from(source_str);
    if fs::write(&source, new_bytes).is_err() {
        return;
    }
    // Update the stored mtime + hash so the next read doesn't think
    // the external changed and re-sync (which would be a harmless
    // no-op but costs an extra read).
    let new_mtime = source_mtime_secs(&source).unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(new_bytes);
    let hex = hex::encode(hasher.finalize());

    let meta_path = node_dir(mount, id).join("meta.json");
    if let Ok(existing) = fs::read_to_string(&meta_path) {
        if let Ok(mut prev) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&existing)
        {
            prev.insert(
                "external_mtime".into(),
                serde_json::Value::Number(new_mtime.into()),
            );
            prev.insert(
                "external_hash".into(),
                serde_json::Value::String(format!("sha256:{}", hex)),
            );
            prev.insert(
                "size_bytes".into(),
                serde_json::Value::Number((new_bytes.len() as u64).into()),
            );
            if let Ok(json) = serde_json::to_string_pretty(&prev) {
                let _ = fs::write(&meta_path, json);
            }
        }
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

#[derive(serde::Deserialize, Clone)]
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

/// Parsed commit log kept in memory so per-node history lookups don't
/// pay for 64 FUSE reads on every tab switch. Invalidated when HEAD
/// moves (a new commit exists that the cache hasn't seen).
struct CommitLogCache {
    head_cid: String,
    commits: Vec<CommitJson>,
    cids: Vec<String>,
}

static COMMIT_CACHE: Mutex<Option<CommitLogCache>> = Mutex::new(None);

/// Return the full parsed commit log (commits + their CIDs, newest
/// first). Uses the cached copy if HEAD hasn't moved, else walks
/// /log/0.../log/63 and rebuilds.
fn commit_log_snapshot(mount: &Path) -> Option<(Vec<CommitJson>, Vec<String>)> {
    let log_dir = mount.join("log");
    let head_cid = fs::read_to_string(log_dir.join("HEAD"))
        .ok()?
        .trim()
        .to_string();
    if head_cid.is_empty() || head_cid == "(none)" {
        return None;
    }

    let mut cache = COMMIT_CACHE.lock().ok()?;
    if let Some(c) = cache.as_ref() {
        if c.head_cid == head_cid {
            return Some((c.commits.clone(), c.cids.clone()));
        }
    }

    // Cache miss: rebuild from /log/.
    let mut commits: Vec<CommitJson> = Vec::new();
    for i in 0..64 {
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

    let mut cids: Vec<String> = Vec::with_capacity(commits.len());
    if !commits.is_empty() {
        cids.push(head_cid.clone());
        for c in &commits[..commits.len().saturating_sub(1)] {
            cids.push(c.parent.clone());
        }
    }

    *cache = Some(CommitLogCache {
        head_cid,
        commits: commits.clone(),
        cids: cids.clone(),
    });
    Some((commits, cids))
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

    // Single cached read of the log; subsequent calls with the same
    // HEAD reuse the parsed commits. This is the big win: a tab
    // switch used to fire 64 FUSE reads + JSON parses per node.
    let (all_commits, all_cids) = match commit_log_snapshot(&mount) {
        Some(pair) => pair,
        None => return Ok(Vec::new()),
    };
    if all_commits.is_empty() {
        return Ok(Vec::new());
    }

    let cap = (limit as usize).min(all_commits.len());
    let commits = &all_commits[..cap];
    let cids = &all_cids[..cap];

    let mut out: Vec<CommitInfo> = Vec::new();
    for i in 0..commits.len() {
        let this_ref = commits[i].refs.get(&id);
        let parent_ref = commits.get(i + 1).and_then(|p| p.refs.get(&id));
        let changed = match (this_ref, parent_ref) {
            (Some(a), Some(b)) => a != b,
            (Some(_), None) => true, // created in this commit (as far as our window sees)
            (None, Some(_)) => true, // deleted in this commit
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
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_node,
            write_node,
            today_note_id,
            read_node_type,
            read_node_bytes,
            read_node_mime,
            read_node_meta_json,
            create_binary_node,
            read_node_labels,
            ingest_path,
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
