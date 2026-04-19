//! Shared helpers for locating the FUSE mount and deriving labels.
//! Moved out of lib.rs so context.rs can reuse them.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use serde_json::Value;

/// Resolve the mount point. $MEMEX_MOUNT wins; otherwise ~/.memex/mount.
pub fn mount_path() -> PathBuf {
    if let Ok(m) = env::var("MEMEX_MOUNT") {
        return PathBuf::from(m);
    }
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".memex").join("mount")
}

/// Validate that we're actually looking at a memex-fs mount by checking
/// for the nodes/ directory. Anything else and we bail with a clear error.
pub fn require_mount() -> Result<PathBuf, String> {
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
pub fn validate_node_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.contains('/') || id.contains("..") {
        return Err(format!("invalid node id: {}", id));
    }
    Ok(())
}

pub fn node_dir(mount: &Path, id: &str) -> PathBuf {
    mount.join("nodes").join(id)
}

pub fn read_meta(mount: &Path, id: &str) -> Option<HashMap<String, Value>> {
    let path = node_dir(mount, id).join("meta.json");
    let raw = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn derive_label(mount: &Path, id: &str) -> String {
    if let Some(meta) = read_meta(mount, id) {
        for key in ["title", "name", "label"] {
            if let Some(v) = meta.get(key).and_then(Value::as_str) {
                let trimmed = v.trim();
                if !trimmed.is_empty() {
                    return trimmed.to_string();
                }
            }
        }
    }
    if let Ok(content) = fs::read_to_string(node_dir(mount, id).join("content")) {
        for raw_line in content.lines() {
            let stripped = raw_line.trim().trim_start_matches('#').trim();
            if !stripped.is_empty() {
                return truncate_label(stripped, 60);
            }
        }
    }
    humanize_id(id)
}

fn truncate_label(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        s.to_string()
    } else {
        let head: String = chars.iter().take(max_chars).collect();
        format!("{}…", head)
    }
}

pub fn humanize_id(id: &str) -> String {
    let (typ, rest) = match id.find(':') {
        Some(i) => (&id[..i], &id[i + 1..]),
        None => return id.to_string(),
    };
    if typ.eq_ignore_ascii_case("daily") {
        if let Ok(d) = NaiveDate::parse_from_str(rest, "%Y-%m-%d") {
            return d.format("%B %-d, %Y").to_string();
        }
    }
    if rest.len() > 16 && rest.chars().all(|c| c.is_ascii_hexdigit()) {
        return format!("{}:{}…", typ, &rest[..8]);
    }
    rest.to_string()
}
