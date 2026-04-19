//! Compile a prompt context for the "ask this document" chat.
//!
//! The philosophy: when a user asks a question about a node, the LLM
//! should see not just the node itself but its authored surroundings —
//! backlinks, outgoing links, and ranked neighbors — so answers can
//! cite the user's own graph instead of external training data.
//!
//! This module formats that context as Markdown so it's readable to
//! both humans (in the "show context" toggle) and LLMs.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use crate::mount::{derive_label, node_dir, read_meta};

/// How many neighbors to include. More = richer context, more tokens.
const NEIGHBOR_LIMIT: usize = 8;

/// How much content to show per neighbor / linked node. Full current
/// node always goes in; peers get truncated so one noisy doc can't
/// dominate the budget.
const PEER_CONTENT_BUDGET: usize = 400;

/// Build the Markdown context block for a node. Returns a string safe
/// to prepend to the user's chat messages.
pub fn compile(mount: &Path, node_id: &str) -> String {
    let mut out = String::new();
    let label = derive_label(mount, node_id);
    let ty = fs::read_to_string(node_dir(mount, node_id).join("type"))
        .unwrap_or_default()
        .trim()
        .to_string();

    out.push_str(&format!("# Current node: {}", label));
    if !ty.is_empty() {
        out.push_str(&format!(" ({})", ty));
    }
    out.push_str(&format!("\nid: `{}`\n\n", node_id));

    if let Some(meta) = read_meta(mount, node_id) {
        if !meta.is_empty() {
            out.push_str("## Meta\n");
            for (k, v) in &meta {
                out.push_str(&format!("- {}: {}\n", k, v));
            }
            out.push('\n');
        }
    }

    if let Ok(content) = fs::read_to_string(node_dir(mount, node_id).join("content")) {
        if !content.trim().is_empty() {
            out.push_str("## Content\n");
            out.push_str(content.trim());
            out.push_str("\n\n");
        }
    }

    // De-dup peers across sections so we don't spend tokens on the same
    // node twice (e.g. a backlink also showing up in neighbors).
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert(node_id.to_string());

    // Backlinks
    let backlinks = list_link_dir(mount, node_id, "backlinks");
    if !backlinks.is_empty() {
        out.push_str("## Backlinks — nodes that reference this one\n");
        for (link_type, peer) in backlinks {
            let parent = strip_block(&peer);
            if !seen.insert(parent.to_string()) {
                continue;
            }
            write_peer_row(&mut out, mount, &parent, Some(&link_type));
        }
        out.push('\n');
    }

    // Outgoing links
    let outgoing = list_link_dir(mount, node_id, "links");
    if !outgoing.is_empty() {
        out.push_str("## Outgoing — nodes this one references\n");
        for (link_type, peer) in outgoing {
            let parent = strip_block(&peer);
            if !seen.insert(parent.to_string()) {
                continue;
            }
            write_peer_row(&mut out, mount, &parent, Some(&link_type));
        }
        out.push('\n');
    }

    // Neighbors (ranked by memex-fs)
    let neighbors = list_dir_names(mount, node_id, "neighbors");
    if !neighbors.is_empty() {
        out.push_str("## Neighbors — related nodes, ranked by memex-fs\n");
        let mut shown = 0;
        for peer in neighbors {
            if shown >= NEIGHBOR_LIMIT {
                break;
            }
            if !seen.insert(peer.clone()) {
                continue;
            }
            write_peer_row(&mut out, mount, &peer, None);
            shown += 1;
        }
    }

    out
}

/// Render one peer row: "- [link_type] **Label** (`id`): preview…"
fn write_peer_row(out: &mut String, mount: &Path, peer: &str, link_type: Option<&str>) {
    let label = derive_label(mount, peer);
    out.push_str("- ");
    if let Some(lt) = link_type {
        out.push_str(&format!("[{}] ", lt));
    }
    out.push_str(&format!("**{}** (`{}`)", label, peer));
    if let Ok(content) = fs::read_to_string(node_dir(mount, peer).join("content")) {
        let trimmed = content.trim();
        if !trimmed.is_empty() {
            let preview = truncate(trimmed, PEER_CONTENT_BUDGET).replace('\n', " ");
            out.push_str(": ");
            out.push_str(&preview);
        }
    }
    out.push('\n');
}

fn truncate(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        s.to_string()
    } else {
        let head: String = chars.iter().take(max_chars).collect();
        format!("{}…", head)
    }
}

fn strip_block(peer: &str) -> String {
    match peer.find('#') {
        Some(i) => peer[..i].to_string(),
        None => peer.to_string(),
    }
}

/// Read a subdir of a node (links/ or backlinks/), returning (link_type, peer_id).
fn list_link_dir(mount: &Path, node_id: &str, sub: &str) -> Vec<(String, String)> {
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

/// Read a plain subdir of a node, returning the entry names in order.
/// Used for neighbors/ where the listing order IS the rank.
fn list_dir_names(mount: &Path, node_id: &str, sub: &str) -> Vec<String> {
    let dir = node_dir(mount, node_id).join(sub);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}
