//! Tauri backend for the memex GUI. Exposes a minimal set of commands the
//! React frontend can invoke to read/write nodes on the memex-fs mount.
//!
//! The GUI is a thin renderer over the filesystem — all real state lives
//! in the mount. This module does just enough to bridge JS to file I/O.

use std::cmp::Ordering;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use serde::Serialize;

/// Resolve the mount point. $MEMEX_MOUNT wins; otherwise ~/.memex/mount.
fn mount_path() -> PathBuf {
    if let Ok(m) = env::var("MEMEX_MOUNT") {
        return PathBuf::from(m);
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".memex").join("mount")
}

/// Validate that we're actually looking at a memex-fs mount by checking
/// for the nodes/ directory. Anything else and we bail with a clear error.
fn require_mount() -> Result<PathBuf, String> {
    let mount = mount_path();
    if !mount.join("nodes").is_dir() {
        return Err(format!(
            "memex-fs is not mounted at {}. Run `memex mount --mount {0}` first.",
            mount.display()
        ));
    }
    Ok(mount)
}

/// Guard against path traversal: node IDs must not contain / or ..
fn validate_node_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return Err(format!("invalid node id: {}", id));
    }
    Ok(())
}

fn node_dir(mount: &Path, id: &str) -> PathBuf {
    mount.join("nodes").join(id)
}

/// Read a node's content. Returns empty string if the content file doesn't
/// exist yet (a newly-created node has no content until first write).
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

/// Write a node's content, creating the node directory if it doesn't
/// exist. mkdir on the FUSE mount triggers memex-fs to create the node
/// with type inferred from the id prefix (e.g. daily: -> Daily).
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

/// Return today's daily note id (e.g. "daily:2026-04-19"). The frontend
/// uses this on launch to open-on-today.
#[tauri::command]
fn today_note_id() -> String {
    format!("daily:{}", Local::now().format("%Y-%m-%d"))
}

/// Read the type string of a node (from /nodes/{id}/type). Returns empty
/// string if the node has no type or the file is missing.
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

#[derive(Serialize)]
struct TypeInfo {
    name: String,
    count: usize,
}

/// List all types on the mount with node counts. Reads /types/ directly,
/// each subdirectory is a Type.
#[tauri::command]
fn list_types() -> Result<Vec<TypeInfo>, String> {
    let mount = require_mount()?;
    let types_dir = mount.join("types");
    let mut types = Vec::new();
    let entries = fs::read_dir(&types_dir)
        .map_err(|e| format!("read {}: {}", types_dir.display(), e))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let count = fs::read_dir(entry.path())
            .map(|it| it.count())
            .unwrap_or(0);
        types.push(TypeInfo { name, count });
    }
    types.sort_by(|a, b| match b.count.cmp(&a.count) {
        Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });
    Ok(types)
}

/// List node IDs of a given type by reading /types/{type}/.
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
    // Daily notes and time-based ids sort best in reverse-lexicographic
    // so the newest is on top; for everything else, plain alphabetical.
    if type_name.eq_ignore_ascii_case("daily") {
        ids.sort_by(|a, b| b.cmp(a));
    } else {
        ids.sort();
    }
    Ok(ids)
}

#[derive(Serialize)]
struct LinkInfo {
    /// The other end of the link (the target when reading outgoing,
    /// the source when reading backlinks).
    peer: String,
    /// The relationship label the author attached (e.g. "cites", "knows").
    link_type: String,
}

/// Parse the FUSE-level link entry name "type:peer-id" into its pieces.
/// Entry names use the first colon as the delimiter; the peer id itself
/// may contain colons and # suffixes.
fn parse_link_entry(name: &str) -> Option<(String, String)> {
    let idx = name.find(':')?;
    Some((name[..idx].to_string(), name[idx + 1..].to_string()))
}

/// Read outgoing links of a node from /nodes/{id}/links/.
#[tauri::command]
fn read_outgoing_links(id: String) -> Result<Vec<LinkInfo>, String> {
    validate_node_id(&id)?;
    let mount = require_mount()?;
    let dir = node_dir(&mount, &id).join("links");
    read_link_entries(&dir)
}

/// Read incoming links of a node from /nodes/{id}/backlinks/.
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

/// Read the ranked neighbors of a node from /nodes/{id}/neighbors/. The
/// order returned by memex-fs IS the ranking — don't re-sort.
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

/// Lightweight status for the frontend to show "mount not found" instead
/// of crashing every invocation.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_node,
            write_node,
            today_note_id,
            read_node_type,
            list_types,
            list_nodes_by_type,
            read_outgoing_links,
            read_backlinks,
            read_neighbors,
            mount_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
