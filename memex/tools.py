"""Combined memex and dagit tools for function calling."""

import os
import json
import httpx

from dotenv import load_dotenv

load_dotenv()


def _get_memex_url() -> str:
    """Get memex server URL at execution time, not import time."""
    return os.getenv("MEMEX_URL", "http://localhost:8080")


# --- Memex Tool Definitions ---

MEMEX_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "memex_search",
            "description": "Full-text search across all nodes in the knowledge graph",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search terms"},
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 10)",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_get_node",
            "description": "Get full details of a specific node by ID",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Node ID (e.g. person:001)",
                    },
                },
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_get_links",
            "description": "Get all relationships for a node",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "Node ID"},
                },
                "required": ["id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_traverse",
            "description": "Traverse graph from a starting node",
            "parameters": {
                "type": "object",
                "properties": {
                    "start": {"type": "string", "description": "Starting node ID"},
                    "depth": {
                        "type": "integer",
                        "description": "Hops to follow (default 2)",
                    },
                },
                "required": ["start"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_filter",
            "description": "Filter nodes by type",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "description": "Node type (Person, Document, etc.)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 20)",
                    },
                },
                "required": ["type"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_create_node",
            "description": "Create a new node in the knowledge graph",
            "parameters": {
                "type": "object",
                "properties": {
                    "type": {
                        "type": "string",
                        "description": "Node type (Note, Document, Person, etc.)",
                    },
                    "content": {
                        "type": "string",
                        "description": "Main content or description",
                    },
                    "title": {
                        "type": "string",
                        "description": "Title or name for the node",
                    },
                },
                "required": ["type", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_ingest",
            "description": "Ingest raw content into memex as a content-addressed Source node. Use this to save articles, web pages, documents, or any raw text the user wants to remember. Content is deduplicated by SHA256 hash.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The raw content to ingest",
                    },
                    "format": {
                        "type": "string",
                        "description": "Format hint (text, json, markdown, etc.)",
                    },
                },
                "required": ["content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_update_node",
            "description": "Update an existing node's metadata or content",
            "parameters": {
                "type": "object",
                "properties": {
                    "id": {
                        "type": "string",
                        "description": "Node ID to update",
                    },
                    "meta": {
                        "type": "object",
                        "description": "Metadata fields to update",
                    },
                },
                "required": ["id", "meta"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "memex_create_link",
            "description": "Create a relationship between two nodes in the knowledge graph",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "Source node ID",
                    },
                    "target": {
                        "type": "string",
                        "description": "Target node ID",
                    },
                    "type": {
                        "type": "string",
                        "description": "Relationship type (e.g. related_to, mentions, authored_by)",
                    },
                },
                "required": ["source", "target", "type"],
            },
        },
    },
]


def get_memex_tools() -> list[dict]:
    """Return memex tool definitions."""
    return MEMEX_TOOLS


def get_dagit_tools() -> list[dict]:
    """Return dagit tool definitions, or empty if not available."""
    try:
        from dagit.agent_tools import tools

        return tools()
    except ImportError:
        return []


def get_all_tools() -> list[dict]:
    """Return combined memex + dagit tools."""
    return get_memex_tools() + get_dagit_tools()


def execute_tool(name: str, args: dict) -> str:
    """Execute a tool and return result as string.

    Args:
        name: Tool name (memex_* or dagit_*)
        args: Tool arguments

    Returns:
        Result string for model consumption
    """
    try:
        if name.startswith("dagit_"):
            return _execute_dagit(name, args)
        elif name.startswith("memex_"):
            return _execute_memex(name, args)
        else:
            return f"Unknown tool: {name}"
    except Exception as e:
        return f"Error: {e}"


def _execute_dagit(name: str, args: dict) -> str:
    """Execute dagit tool and return string result."""
    try:
        from dagit.agent_tools import execute

        result = execute(name, args)
        if result.get("success"):
            return json.dumps(result.get("result", {}), indent=2)
        else:
            return f"Error: {result.get('error', 'Unknown error')}"
    except ImportError:
        return "Error: dagit not installed. Install with: pip install dagit"


def _execute_memex(name: str, args: dict) -> str:
    """Execute memex tool and return string result."""
    if name == "memex_search":
        return _memex_search(args)
    elif name == "memex_get_node":
        return _memex_get_node(args)
    elif name == "memex_get_links":
        return _memex_get_links(args)
    elif name == "memex_traverse":
        return _memex_traverse(args)
    elif name == "memex_filter":
        return _memex_filter(args)
    elif name == "memex_create_node":
        return _memex_create_node(args)
    elif name == "memex_ingest":
        return _memex_ingest(args)
    elif name == "memex_update_node":
        return _memex_update_node(args)
    elif name == "memex_create_link":
        return _memex_create_link(args)
    else:
        return f"Unknown memex tool: {name}"


def _memex_search(args: dict) -> str:
    query = args.get("query", "")
    limit = args.get("limit", 10)

    resp = httpx.get(
        f"{_get_memex_url()}/api/query/search",
        params={"q": query, "limit": limit},
        timeout=10,
    )

    if resp.status_code != 200:
        return f"Search failed: {resp.status_code}"

    data = resp.json()
    nodes = data.get("nodes", [])

    if not nodes:
        return f"No results for '{query}'"

    lines = [f"Found {len(nodes)} results:"]
    for n in nodes:
        nid = n.get("ID", "")
        ntype = n.get("Type", "")
        meta = n.get("Meta", {})
        name = meta.get("name") or meta.get("title") or nid
        lines.append(f"  [{ntype}] {name} (id: {nid})")

    return "\n".join(lines)


def _memex_get_node(args: dict) -> str:
    node_id = args.get("id", "")

    resp = httpx.get(f"{_get_memex_url()}/api/nodes/{node_id}", timeout=10)

    if resp.status_code != 200:
        return f"Node not found: {node_id}"

    n = resp.json()
    lines = [f"Node: {node_id}", f"  Type: {n.get('Type', '')}"]

    meta = n.get("Meta", {})
    for k, v in meta.items():
        if isinstance(v, (str, int, float, bool)):
            lines.append(f"  {k}: {v}")

    return "\n".join(lines)


def _memex_get_links(args: dict) -> str:
    node_id = args.get("id", "")

    resp = httpx.get(f"{_get_memex_url()}/api/nodes/{node_id}/links", timeout=10)

    if resp.status_code != 200:
        return f"No links for: {node_id}"

    data = resp.json()
    links = data if isinstance(data, list) else data.get("links", [])

    if not links:
        return f"No links for {node_id}"

    # Dedupe links
    seen = set()
    unique_links = []
    for link in links:
        key = (link.get("Source"), link.get("Target"), link.get("Type"))
        if key not in seen:
            seen.add(key)
            unique_links.append(link)

    lines = [f"Links for {node_id} ({len(unique_links)}):"]
    for link in unique_links[:20]:
        src = link.get("Source", "")
        tgt = link.get("Target", "")
        ltype = link.get("Type", "")
        if src == node_id:
            lines.append(f"  --[{ltype}]--> {tgt}")
        else:
            lines.append(f"  <--[{ltype}]-- {src}")

    if len(unique_links) > 20:
        lines.append(f"  ... and {len(unique_links) - 20} more")

    return "\n".join(lines)


def _memex_traverse(args: dict) -> str:
    start = args.get("start", "")
    depth = args.get("depth", 2)

    resp = httpx.get(
        f"{_get_memex_url()}/api/query/traverse",
        params={"start": start, "depth": depth},
        timeout=10,
    )

    if resp.status_code != 200:
        return f"Traverse failed from: {start}"

    data = resp.json()
    nodes = data.get("nodes", [])
    edges = data.get("edges", [])

    if not nodes:
        return f"No nodes from {start}"

    lines = [f"Traversal from {start}: {len(nodes)} nodes, {len(edges)} edges"]
    for n in nodes[:10]:
        nid = n.get("ID", "")
        ntype = n.get("Type", "")
        meta = n.get("Meta", {})
        name = meta.get("name") or meta.get("title") or nid
        lines.append(f"  [{ntype}] {name}")

    if len(nodes) > 10:
        lines.append(f"  ... and {len(nodes) - 10} more")

    return "\n".join(lines)


def _memex_filter(args: dict) -> str:
    ntype = args.get("type", "")
    limit = args.get("limit", 20)

    resp = httpx.get(
        f"{_get_memex_url()}/api/query/filter",
        params={"type": ntype, "limit": limit},
        timeout=10,
    )

    if resp.status_code != 200:
        return f"Filter failed for type: {ntype}"

    data = resp.json()
    nodes = data.get("nodes", [])

    if not nodes:
        return f"No {ntype} nodes found"

    lines = [f"{ntype} nodes ({len(nodes)}):"]
    for n in nodes:
        nid = n.get("ID", "") if isinstance(n, dict) else n
        lines.append(f"  {nid}")

    return "\n".join(lines)


def _memex_create_node(args: dict) -> str:
    import hashlib
    import time

    ntype = args.get("type", "Note")
    content = args.get("content", "")
    title = args.get("title", "")

    # Generate a stable, short ID from type + content
    prefix = ntype.lower()
    hash_input = f"{content}{title}{time.time()}"
    short_hash = hashlib.sha256(hash_input.encode()).hexdigest()[:8]
    node_id = f"{prefix}:{short_hash}"

    payload = {
        "id": node_id,
        "type": ntype,
        "meta": {
            "content": content,
        },
    }
    if title:
        payload["meta"]["title"] = title

    resp = httpx.post(
        f"{_get_memex_url()}/api/nodes",
        json=payload,
        timeout=10,
    )

    if resp.status_code not in (200, 201):
        return f"Create failed: {resp.status_code} - {resp.text}"

    data = resp.json()
    node_id = data.get("id") or data.get("ID", node_id)
    return f"Created {ntype} node: {node_id}"


def _memex_ingest(args: dict) -> str:
    content = args.get("content", "")
    fmt = args.get("format", "text")

    if not content:
        return "Error: content is required"

    resp = httpx.post(
        f"{_get_memex_url()}/api/ingest",
        json={"content": content, "format": fmt},
        timeout=10,
    )

    if resp.status_code != 200:
        return f"Ingest failed: {resp.status_code} - {resp.text}"

    data = resp.json()
    source_id = data.get("source_id", "unknown")
    return f"Ingested as {source_id}"


def ingest_conversation_turn(user_msg: str, assistant_msg: str, tool_calls: list[str] | None = None) -> str | None:
    """Ingest a conversation turn into memex. Returns source_id or None on failure.

    Called automatically after each conversation exchange — this is what makes
    memex the desktop memory. Content-addressed so duplicates are free.
    """
    parts = [f"User: {user_msg}", ""]
    if tool_calls:
        for tc in tool_calls:
            parts.append(f"  [{tc}]")
        parts.append("")
    parts.append(f"Memex: {assistant_msg}")

    content = "\n".join(parts)

    try:
        resp = httpx.post(
            f"{_get_memex_url()}/api/ingest",
            json={"content": content, "format": "conversation"},
            timeout=5,
        )
        if resp.status_code == 200:
            return resp.json().get("source_id")
    except Exception:
        pass
    return None


def load_recent_conversations(limit: int = 20) -> list[dict]:
    """Load recent conversation turns from the graph.

    Returns a list of message dicts suitable for prepending to chat history,
    giving the LLM memory across sessions.
    """
    import base64

    try:
        resp = httpx.get(
            f"{_get_memex_url()}/api/query/filter",
            params={"type": "Source", "limit": limit},
            timeout=5,
        )
        if resp.status_code != 200:
            return []

        data = resp.json()
        nodes = data.get("nodes", []) if isinstance(data, dict) else data

        conversations = []
        for node in nodes:
            if not isinstance(node, dict):
                continue
            meta = node.get("Meta", {})
            if meta.get("format") != "conversation":
                continue
            raw = node.get("Content", "")
            # Content comes back as base64 from the Go API ([]byte → JSON)
            if not raw:
                continue
            try:
                content = base64.b64decode(raw).decode("utf-8", errors="replace")
            except Exception:
                content = raw if isinstance(raw, str) else ""
            if not content:
                continue
            conversations.append({
                "id": node.get("ID", ""),
                "content": content,
                "ingested_at": meta.get("ingested_at", ""),
            })

        # Sort by ingestion time (oldest first so newest is most recent context)
        conversations.sort(key=lambda c: c.get("ingested_at", ""))

        # Parse back into message pairs
        messages = []
        for conv in conversations:
            content = conv["content"]
            # Parse "User: ...\n\nMemex: ..." format
            user_part = ""
            assistant_part = ""
            in_assistant = False
            for line in content.split("\n"):
                if line.startswith("User: "):
                    user_part = line[6:]
                elif line.startswith("Memex: "):
                    assistant_part = line[7:]
                    in_assistant = True
                elif in_assistant:
                    assistant_part += "\n" + line
                elif user_part and not line.startswith("  ["):
                    user_part += "\n" + line

            if user_part and assistant_part:
                messages.append({"role": "user", "content": user_part.strip()})
                messages.append({"role": "assistant", "content": assistant_part.strip()})

        return messages

    except Exception:
        return []


def _memex_update_node(args: dict) -> str:
    node_id = args.get("id", "")
    meta = args.get("meta", {})

    if not node_id:
        return "Error: id is required"

    resp = httpx.patch(
        f"{_get_memex_url()}/api/nodes/{node_id}",
        json={"meta": meta},
        timeout=10,
    )

    if resp.status_code != 200:
        return f"Update failed: {resp.status_code} - {resp.text}"

    return f"Updated node: {node_id}"


def _memex_create_link(args: dict) -> str:
    source = args.get("source", "")
    target = args.get("target", "")
    link_type = args.get("type", "related_to")

    if not source or not target:
        return "Error: source and target are required"

    resp = httpx.post(
        f"{_get_memex_url()}/api/links",
        json={"source": source, "target": target, "type": link_type},
        timeout=10,
    )

    if resp.status_code not in (200, 201):
        return f"Link failed: {resp.status_code} - {resp.text}"

    return f"Created link: {source} --[{link_type}]--> {target}"
