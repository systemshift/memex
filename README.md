# Memex

AI-native knowledge graph + decentralized social network.

## Install

```bash
pip install memex-graph
memex-stack
```

## What happens

- Downloads knowledge graph server + IPFS automatically
- Creates your cryptographic identity (Ed25519 DID)
- Guides you through your first interaction

## What is this

- **Knowledge graph** ([memex-server](https://github.com/systemshift/memex-server)): entities, relationships, raw sources — stored locally in SQLite
- **Social network** ([dagit](https://github.com/systemshift/dagit)): IPFS-based, Ed25519-signed, no central servers
- **LLM** (OpenAI): searches your graph, creates nodes, posts to dagit — all through natural language chat

## Prerequisites

- Python 3.10+
- `OPENAI_API_KEY` environment variable set

```bash
export OPENAI_API_KEY=sk-...
```

## Architecture

```
┌─────────────────────────────────────┐
│              memex TUI              │
│         (textual chat UI)           │
├─────────────┬───────────────────────┤
│  OpenAI API │    function calls     │
├─────────────┼───────────┬───────────┤
│ memex-server│   dagit   │   IPFS    │
│  (SQLite)   │  (Ed25519)│  (kubo)   │
└─────────────┴───────────┴───────────┘
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENAI_API_KEY` | (required) | OpenAI API key |
| `PORT` | `8080` | memex-server port |
| `MEMEX_BACKEND` | `sqlite` | Storage backend (`sqlite` or `neo4j`) |
| `SQLITE_PATH` | `~/.memex/memex.db` | Database path |
| `MEMEX_SERVER` | (auto-detect) | Path to memex-server binary |

## CLI Flags

```
memex-stack [options]

  --server-only     Start server without TUI
  --port PORT       Server port (default: 8080)
  --backend TYPE    sqlite or neo4j (default: sqlite)
  --db-path PATH    SQLite database path
  --skip-ipfs       Skip IPFS daemon setup
  --skip-download   Don't auto-download binaries
```

## License

BSD 3-Clause. See [LICENSE](LICENSE).
