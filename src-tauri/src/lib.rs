//! Tauri backend for the memex GUI. Exposes a minimal set of commands the
//! React frontend can invoke to read/write nodes on the memex-fs mount.
//!
//! The GUI is a thin renderer over the filesystem — all real state lives
//! in the mount. This module does just enough to bridge JS to file I/O.

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
            mount_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
