/**
 * 14 tool definitions + execution (9 memex, 5 dagit).
 */

import { createHash } from "crypto";
import * as identity from "./identity";
import * as messages from "./messages";
import * as ipfs from "./ipfs";

function getMemexUrl(): string {
  return process.env.MEMEX_URL ?? "http://localhost:8080";
}

// --- Tool Definitions (Responses API format) ---

export const TOOL_DEFS: any[] = [
  // Memex tools
  {
    type: "function",
    name: "memex_search",
    description: "Full-text search across all nodes in the knowledge graph",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms" },
        limit: { type: "integer", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_get_node",
    description: "Get full details of a specific node by ID",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node ID (e.g. person:001)" },
      },
      required: ["id"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_get_links",
    description: "Get all relationships for a node",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node ID" },
      },
      required: ["id"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_traverse",
    description: "Traverse graph from a starting node",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Starting node ID" },
        depth: { type: "integer", description: "Hops to follow (default 2)" },
      },
      required: ["start"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_filter",
    description: "Filter nodes by type",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type (Person, Document, etc.)" },
        limit: { type: "integer", description: "Max results (default 20)" },
      },
      required: ["type"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_create_node",
    description: "Create a new node in the knowledge graph",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type (Note, Document, Person, etc.)" },
        content: { type: "string", description: "Main content or description" },
        title: { type: "string", description: "Title or name for the node" },
      },
      required: ["type", "content"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_ingest",
    description: "Ingest raw content into memex as a content-addressed Source node. Use this to save articles, web pages, documents, or any raw text the user wants to remember. Content is deduplicated by SHA256 hash.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The raw content to ingest" },
        format: { type: "string", description: "Format hint (text, json, markdown, etc.)" },
      },
      required: ["content"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_update_node",
    description: "Update an existing node's metadata or content",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node ID to update" },
        meta: { type: "object", description: "Metadata fields to update" },
      },
      required: ["id", "meta"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_create_link",
    description: "Create a relationship between two nodes in the knowledge graph",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source node ID" },
        target: { type: "string", description: "Target node ID" },
        type: { type: "string", description: "Relationship type (e.g. related_to, mentions, authored_by)" },
      },
      required: ["source", "target", "type"],
    },
    strict: false,
  },
  // Dagit tools
  {
    type: "function",
    name: "dagit_whoami",
    description: "Get the current agent's DID (decentralized identifier)",
    parameters: { type: "object", properties: {}, required: [] },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_post",
    description: "Post a message to the dagit network. Signs with your identity and publishes to IPFS.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The message content to post" },
        refs: { type: "array", items: { type: "string" }, description: "List of CIDs this post references" },
        tags: { type: "array", items: { type: "string" }, description: "List of topic tags" },
      },
      required: ["content"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_read",
    description: "Read a post from IPFS by its CID and verify the signature",
    parameters: {
      type: "object",
      properties: {
        cid: { type: "string", description: "The IPFS content identifier of the post" },
      },
      required: ["cid"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_reply",
    description: "Reply to an existing post on dagit (shorthand for post with refs=[cid])",
    parameters: {
      type: "object",
      properties: {
        cid: { type: "string", description: "The CID of the post to reply to" },
        content: { type: "string", description: "The reply message content" },
        tags: { type: "array", items: { type: "string" }, description: "List of topic tags" },
      },
      required: ["cid", "content"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_verify",
    description: "Verify if a post's signature is valid",
    parameters: {
      type: "object",
      properties: {
        cid: { type: "string", description: "The CID of the post to verify" },
      },
      required: ["cid"],
    },
    strict: false,
  },
];

// --- Tool Execution ---

export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    if (name.startsWith("dagit_")) return await executeDagit(name, args);
    if (name.startsWith("memex_")) return await executeMemex(name, args);
    return `Unknown tool: ${name}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function executeMemex(name: string, args: Record<string, any>): Promise<string> {
  const url = getMemexUrl();

  switch (name) {
    case "memex_search": {
      const params = new URLSearchParams({ q: args.query, limit: String(args.limit ?? 10) });
      const resp = await fetch(`${url}/api/query/search?${params}`, { signal: AbortSignal.timeout(10000) });
      if (resp.status !== 200) return `Search failed: ${resp.status}`;
      const data = await resp.json() as any;
      const nodes = data.nodes ?? [];
      if (!nodes.length) return `No results for '${args.query}'`;
      const lines = [`Found ${nodes.length} results:`];
      for (const n of nodes) {
        const nid = n.ID ?? "";
        const ntype = n.Type ?? "";
        const meta = n.Meta ?? {};
        const name = meta.name ?? meta.title ?? nid;
        lines.push(`  [${ntype}] ${name} (id: ${nid})`);
      }
      return lines.join("\n");
    }

    case "memex_get_node": {
      const resp = await fetch(`${url}/api/nodes/${args.id}`, { signal: AbortSignal.timeout(10000) });
      if (resp.status !== 200) return `Node not found: ${args.id}`;
      const n = await resp.json() as any;
      const lines = [`Node: ${args.id}`, `  Type: ${n.Type ?? ""}`];
      const meta = n.Meta ?? {};
      for (const [k, v] of Object.entries(meta)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          lines.push(`  ${k}: ${v}`);
        }
      }
      return lines.join("\n");
    }

    case "memex_get_links": {
      const resp = await fetch(`${url}/api/nodes/${args.id}/links`, { signal: AbortSignal.timeout(10000) });
      if (resp.status !== 200) return `No links for: ${args.id}`;
      const data = await resp.json() as any;
      const links: any[] = Array.isArray(data) ? data : (data.links ?? []);
      if (!links.length) return `No links for ${args.id}`;

      const seen = new Set<string>();
      const unique: any[] = [];
      for (const link of links) {
        const key = `${link.Source}|${link.Target}|${link.Type}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(link);
        }
      }

      const lines = [`Links for ${args.id} (${unique.length}):`];
      for (const link of unique.slice(0, 20)) {
        if (link.Source === args.id) {
          lines.push(`  --[${link.Type}]--> ${link.Target}`);
        } else {
          lines.push(`  <--[${link.Type}]-- ${link.Source}`);
        }
      }
      if (unique.length > 20) lines.push(`  ... and ${unique.length - 20} more`);
      return lines.join("\n");
    }

    case "memex_traverse": {
      const params = new URLSearchParams({ start: args.start, depth: String(args.depth ?? 2) });
      const resp = await fetch(`${url}/api/query/traverse?${params}`, { signal: AbortSignal.timeout(10000) });
      if (resp.status !== 200) return `Traverse failed from: ${args.start}`;
      const data = await resp.json() as any;
      const nodes = data.nodes ?? [];
      const edges = data.edges ?? [];
      if (!nodes.length) return `No nodes from ${args.start}`;

      const lines = [`Traversal from ${args.start}: ${nodes.length} nodes, ${edges.length} edges`];
      for (const n of nodes.slice(0, 10)) {
        const meta = n.Meta ?? {};
        const label = meta.name ?? meta.title ?? n.ID;
        lines.push(`  [${n.Type}] ${label}`);
      }
      if (nodes.length > 10) lines.push(`  ... and ${nodes.length - 10} more`);
      return lines.join("\n");
    }

    case "memex_filter": {
      const params = new URLSearchParams({ type: args.type, limit: String(args.limit ?? 20) });
      const resp = await fetch(`${url}/api/query/filter?${params}`, { signal: AbortSignal.timeout(10000) });
      if (resp.status !== 200) return `Filter failed for type: ${args.type}`;
      const data = await resp.json() as any;
      const nodes = data.nodes ?? [];
      if (!nodes.length) return `No ${args.type} nodes found`;

      const lines = [`${args.type} nodes (${nodes.length}):`];
      for (const n of nodes) {
        const nid = typeof n === "string" ? n : (n.ID ?? "");
        lines.push(`  ${nid}`);
      }
      return lines.join("\n");
    }

    case "memex_create_node": {
      const ntype = args.type ?? "Note";
      const content = args.content ?? "";
      const title = args.title ?? "";

      const prefix = ntype.toLowerCase();
      const hashInput = `${content}${title}${Date.now()}`;
      const shortHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
      const nodeId = `${prefix}:${shortHash}`;

      const payload: any = {
        id: nodeId,
        type: ntype,
        meta: { content },
      };
      if (title) payload.meta.title = title;

      const resp = await fetch(`${url}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status !== 200 && resp.status !== 201) {
        return `Create failed: ${resp.status} - ${await resp.text()}`;
      }
      const data = await resp.json() as any;
      const finalId = data.id ?? data.ID ?? nodeId;
      return `Created ${ntype} node: ${finalId}`;
    }

    case "memex_ingest": {
      const content = args.content ?? "";
      const format = args.format ?? "text";
      if (!content) return "Error: content is required";

      const resp = await fetch(`${url}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, format }),
        signal: AbortSignal.timeout(10000),
      });

      if (resp.status !== 200) return `Ingest failed: ${resp.status} - ${await resp.text()}`;
      const data = await resp.json() as any;
      return `Ingested as ${data.source_id ?? "unknown"}`;
    }

    case "memex_update_node": {
      if (!args.id) return "Error: id is required";
      const resp = await fetch(`${url}/api/nodes/${args.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meta: args.meta ?? {} }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status !== 200) return `Update failed: ${resp.status} - ${await resp.text()}`;
      return `Updated node: ${args.id}`;
    }

    case "memex_create_link": {
      if (!args.source || !args.target) return "Error: source and target are required";
      const resp = await fetch(`${url}/api/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: args.source, target: args.target, type: args.type ?? "related_to" }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.status !== 200 && resp.status !== 201) {
        return `Link failed: ${resp.status} - ${await resp.text()}`;
      }
      return `Created link: ${args.source} --[${args.type ?? "related_to"}]--> ${args.target}`;
    }

    default:
      return `Unknown memex tool: ${name}`;
  }
}

async function executeDagit(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "dagit_whoami": {
      const ident = await identity.loadIdentity();
      if (!ident) return "Error: No identity found. Initialize first.";
      return JSON.stringify({ did: ident.did }, null, 2);
    }

    case "dagit_post": {
      if (!args.content) return "Error: Content is required";
      if (!(await ipfs.isAvailable())) return "Error: IPFS daemon not available";
      const cid = await messages.publish(args.content, args.refs ?? undefined, args.tags ?? undefined);
      return JSON.stringify({ cid, content: args.content, refs: args.refs, tags: args.tags }, null, 2);
    }

    case "dagit_read": {
      if (!args.cid) return "Error: CID is required";
      if (!(await ipfs.isAvailable())) return "Error: IPFS daemon not available";
      const [post, verified] = await messages.fetchPost(args.cid);
      return JSON.stringify({ post, verified, cid: args.cid }, null, 2);
    }

    case "dagit_reply": {
      if (!args.cid || !args.content) return "Error: CID and content are required";
      if (!(await ipfs.isAvailable())) return "Error: IPFS daemon not available";
      const replyCid = await messages.publish(args.content, [args.cid], args.tags ?? undefined);
      return JSON.stringify({ cid: replyCid, refs: [args.cid], tags: args.tags, content: args.content }, null, 2);
    }

    case "dagit_verify": {
      if (!args.cid) return "Error: CID is required";
      if (!(await ipfs.isAvailable())) return "Error: IPFS daemon not available";
      const [post, verified] = await messages.fetchPost(args.cid);
      return JSON.stringify({ verified, author: post.author, cid: args.cid }, null, 2);
    }

    default:
      return `Unknown dagit tool: ${name}`;
  }
}

// --- Conversation helpers ---

export async function ingestConversationTurn(
  userMsg: string,
  assistantMsg: string,
  toolCalls?: string[],
): Promise<string | null> {
  const parts = [`User: ${userMsg}`, ""];
  if (toolCalls?.length) {
    for (const tc of toolCalls) parts.push(`  [${tc}]`);
    parts.push("");
  }
  parts.push(`Memex: ${assistantMsg}`);

  const content = parts.join("\n");

  try {
    const resp = await fetch(`${getMemexUrl()}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, format: "conversation" }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 200) {
      const data = await resp.json() as any;
      return data.source_id ?? null;
    }
  } catch {}
  return null;
}

export async function loadRecentConversations(limit = 20): Promise<Array<{ role: string; content: string }>> {
  try {
    const params = new URLSearchParams({ type: "Source", limit: String(limit) });
    const resp = await fetch(`${getMemexUrl()}/api/query/filter?${params}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status !== 200) return [];

    const data = await resp.json() as any;
    const nodes: any[] = Array.isArray(data) ? data : (data.nodes ?? []);

    const conversations: Array<{ id: string; content: string; ingested_at: string }> = [];

    for (const node of nodes) {
      if (typeof node !== "object") continue;
      const meta = node.Meta ?? {};
      if (meta.format !== "conversation") continue;
      const raw = node.Content ?? "";
      if (!raw) continue;

      let content: string;
      try {
        // Content comes back as base64 from Go API ([]byte -> JSON)
        content = Buffer.from(raw, "base64").toString("utf-8");
      } catch {
        content = typeof raw === "string" ? raw : "";
      }
      if (!content) continue;

      conversations.push({
        id: node.ID ?? "",
        content,
        ingested_at: meta.ingested_at ?? "",
      });
    }

    // Sort oldest first
    conversations.sort((a, b) => a.ingested_at.localeCompare(b.ingested_at));

    // Parse back into message pairs
    const msgs: Array<{ role: string; content: string }> = [];
    for (const conv of conversations) {
      let userPart = "";
      let assistantPart = "";
      let inAssistant = false;

      for (const line of conv.content.split("\n")) {
        if (line.startsWith("User: ")) {
          userPart = line.slice(6);
        } else if (line.startsWith("Memex: ")) {
          assistantPart = line.slice(7);
          inAssistant = true;
        } else if (inAssistant) {
          assistantPart += "\n" + line;
        } else if (userPart && !line.startsWith("  [")) {
          userPart += "\n" + line;
        }
      }

      if (userPart && assistantPart) {
        msgs.push({ role: "user", content: userPart.trim() });
        msgs.push({ role: "assistant", content: assistantPart.trim() });
      }
    }

    return msgs;
  } catch {
    return [];
  }
}
