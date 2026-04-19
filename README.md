# memex

A desktop app for the memex-fs knowledge graph.

## Status

**v0.3 — rewrite in progress.** The previous chat-TUI CLI (Bun/TypeScript,
versions 0.1.x–0.2.x) has been retired in favor of a Tauri GUI. The git
history preserves the old code if you want to dig.

What's in this repo today:
- Rust backend (`src-tauri/`) with a subcommand dispatcher for `mount`,
  `push`, `pull`, `capture`, plus a Tauri entry point for the GUI.
- React + TypeScript frontend (`src/`) — minimal: opens today's daily
  note and autosaves as you type.

It's the skeleton, not the product. Panels for backlinks, neighbors,
time-travel, emergent clusters, and federation all land in later work.

## Running

You need the `memex-fs` binary on `PATH` (built from
[memex-fs](https://github.com/systemshift/memex-fs)) and the mount
already running:

```sh
memex-fs mount --data ~/.memex/data --mount ~/.memex/mount
```

Then in this repo:

```sh
npm install
npm run tauri dev
```

## CLI subcommands

The Rust binary doubles as a CLI; no args launches the GUI.

```sh
memex                          # launch GUI
memex capture                  # open today's daily note in $EDITOR
memex mount --mount <path>     # delegates to memex-fs
memex push [--publish]         # delegates to memex-fs
memex pull <cid-or-did>        # delegates to memex-fs
memex help
```

## Architecture

```
memex (Tauri binary)
├── Rust backend
│   ├── subcommand dispatch (mount/push/pull/capture → memex-fs binary)
│   └── Tauri commands: read_node, write_node, today_note_id, mount_status
└── React frontend (webview)
    └── minimal daily-note editor; panels land in subsequent commits
```

The actual graph, history, neighbors, and federation all live in
memex-fs. This repo is just a front-end.

## License

See [LICENSE](LICENSE).
