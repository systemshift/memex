// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::{exit, Command};

fn main() {
    let args: Vec<String> = env::args().collect();

    // Subcommand dispatch. Unknown args and no args both launch the GUI so
    // e.g. a macOS "open" with an app-URL doesn't surprise-terminate.
    match args.get(1).map(String::as_str) {
        Some("mount") | Some("push") | Some("pull") => {
            delegate_to_memex_fs(&args[1..]);
        }
        Some("capture") => {
            if let Err(e) = capture_daily_note() {
                eprintln!("memex capture: {}", e);
                exit(1);
            }
        }
        Some("-h") | Some("--help") | Some("help") => {
            print_help();
        }
        _ => {
            memex_lib::run();
        }
    }
}

/// Shell out to the memex-fs binary for storage/federation commands.
/// The GUI itself never needs this — these are for terminal/scripting use.
fn delegate_to_memex_fs(forward: &[String]) {
    let bin = find_memex_fs_binary();
    let status = Command::new(&bin)
        .args(forward)
        .status()
        .unwrap_or_else(|e| {
            eprintln!("memex: failed to execute {}: {}", bin.display(), e);
            exit(127);
        });
    exit(status.code().unwrap_or(1));
}

/// Look for the memex-fs binary in PATH first, then a couple of common
/// install locations. Falls back to the literal name so the error message
/// from Command::new is honest.
fn find_memex_fs_binary() -> PathBuf {
    if let Ok(path) = which("memex-fs") {
        return path;
    }
    if let Some(home) = env::var_os("HOME") {
        let go_bin = PathBuf::from(&home).join("gopath/bin/memex-fs");
        if go_bin.exists() {
            return go_bin;
        }
    }
    PathBuf::from("memex-fs")
}

fn which(name: &str) -> Result<PathBuf, ()> {
    let path_var = env::var_os("PATH").ok_or(())?;
    for dir in env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(())
}

/// Capture-first UX: open $EDITOR on today's daily note.
/// Creates the node directory on the FUSE mount if missing (memex-fs
/// infers Type=Daily from the id prefix).
fn capture_daily_note() -> Result<(), String> {
    let mount = env::var("MEMEX_MOUNT").unwrap_or_else(|_| {
        let home = env::var("HOME").unwrap_or_else(|_| ".".into());
        format!("{}/.memex/mount", home)
    });

    let nodes_dir = PathBuf::from(&mount).join("nodes");
    if !nodes_dir.exists() {
        return Err(format!(
            "memex-fs is not mounted at {}\nStart it with: memex mount --data ~/.memex/data --mount {}",
            mount, mount
        ));
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let node_id = format!("daily:{}", today);
    let node_dir = nodes_dir.join(&node_id);
    let content_path = node_dir.join("content");

    if !node_dir.exists() {
        fs::create_dir_all(&node_dir).map_err(|e| format!("create node dir: {}", e))?;
    }
    if !content_path.exists() {
        fs::write(&content_path, "").map_err(|e| format!("touch content: {}", e))?;
    }

    let editor = env::var("EDITOR")
        .or_else(|_| env::var("VISUAL"))
        .unwrap_or_else(|_| "vi".into());

    let status = Command::new(&editor)
        .arg(&content_path)
        .status()
        .map_err(|e| format!("launch {}: {}", editor, e))?;

    if !status.success() {
        exit(status.code().unwrap_or(1));
    }
    Ok(())
}

fn print_help() {
    println!(
        "memex — GUI and CLI for the memex-fs knowledge graph

Usage: memex [command]

Commands:
  (no command)   Launch the GUI
  capture        Open today's daily note in $EDITOR
  mount          Mount memex-fs (delegates to the memex-fs binary)
  push           Push HEAD to IPFS (delegates to memex-fs)
  pull           Pull a CID or DID from IPFS (delegates to memex-fs)
  help           Show this help

Environment:
  MEMEX_MOUNT    FUSE mount path (default: ~/.memex/mount)
"
    );
}
