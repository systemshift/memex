/**
 * 23 tool definitions + execution (10 memex, 10 dagit, 3 email).
 * Dagit posts (outbound + inbound) are ingested as Post nodes in the graph.
 */

import { createHash } from "crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, symlinkSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as identity from "./identity";
import * as messages from "./messages";
import * as ipfs from "./ipfs";
import * as email from "./email";
import { ingestNewEmails, stripHtml } from "./email-ingest";
import { exploreGraph } from "./explore";

export function getMountPath(): string {
  return process.env.MEMEX_MOUNT ?? join(homedir(), ".memex", "mount");
}

export function getDataPath(): string {
  return process.env.MEMEX_DATA ?? join(homedir(), ".memex", "data");
}

// --- FS helpers for reading nodes/links ---

export interface NodeData {
  id: string;
  type: string;
  meta: Record<string, any>;
  content: string;
}

export interface LinkData {
  source: string;
  target: string;
  type: string;
}

export function fsReadNode(nodeId: string): NodeData | null {
  const mount = getMountPath();
  const nodeDir = join(mount, "nodes", nodeId);
  try {
    const content = readFileSync(join(nodeDir, "content"), "utf-8");
    const metaRaw = readFileSync(join(nodeDir, "meta.json"), "utf-8");
    const type = readFileSync(join(nodeDir, "type"), "utf-8").trim();
    const meta = JSON.parse(metaRaw);
    return { id: nodeId, type, meta, content };
  } catch {
    return null;
  }
}

export function fsReadOutgoingLinks(nodeId: string): LinkData[] {
  const mount = getMountPath();
  const linksDir = join(mount, "nodes", nodeId, "links");
  try {
    const entries = readdirSync(linksDir);
    return entries.map(entry => {
      // entry format: {linkType}:{targetID} — first colon separates type from target
      const colonIdx = entry.indexOf(":");
      if (colonIdx === -1) return { source: nodeId, target: entry, type: "related_to" };
      return {
        source: nodeId,
        target: entry.slice(colonIdx + 1),
        type: entry.slice(0, colonIdx),
      };
    });
  } catch {
    return [];
  }
}

export function fsReadIncomingLinks(nodeId: string): LinkData[] {
  const dataPath = getDataPath();
  const linksFile = join(dataPath, ".mx", "links.jsonl");
  const incoming: LinkData[] = [];
  try {
    const raw = readFileSync(linksFile, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.target === nodeId) {
          incoming.push({ source: entry.source, target: entry.target, type: entry.type });
        }
      } catch {}
    }
  } catch {}
  return incoming;
}

export function fsReadAllLinks(nodeId: string): LinkData[] {
  const outgoing = fsReadOutgoingLinks(nodeId);
  const incoming = fsReadIncomingLinks(nodeId);
  // Deduplicate (outgoing links also appear in links.jsonl)
  const seen = new Set<string>();
  const all: LinkData[] = [];
  for (const link of [...outgoing, ...incoming]) {
    const key = `${link.source}|${link.target}|${link.type}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(link);
    }
  }
  return all;
}

export function fsSearchNodes(query: string, limit = 10): string[] {
  const mount = getMountPath();
  try {
    const entries = readdirSync(join(mount, "search", query));
    return entries.slice(0, limit);
  } catch {
    return [];
  }
}

export function fsCreateNode(nodeId: string, content: string, meta: Record<string, any>): void {
  const mount = getMountPath();
  const nodeDir = join(mount, "nodes", nodeId);
  mkdirSync(nodeDir, { recursive: true });
  writeFileSync(join(nodeDir, "content"), content);
  writeFileSync(join(nodeDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
}

export function fsCreateLink(source: string, target: string, linkType: string): void {
  const mount = getMountPath();
  const linkPath = join(mount, "nodes", source, "links", `${linkType}:${target}`);
  try {
    symlinkSync(`../../${target}`, linkPath);
  } catch (e: any) {
    if (e.code !== "EEXIST") throw e;
  }
}

// --- Inline reference extraction ---

function extractInlineRefs(content: string): string[] {
  const matches = content.matchAll(/\[\[([\w]+:[a-f0-9]{8,64})\]\]/g);
  return [...new Set([...matches].map(m => m[1]))];
}

// --- Dagit following.json reader ---

function readFollowingCids(): Array<{ did: string; alias: string; cids: string[] }> {
  try {
    const raw = readFileSync(join(homedir(), ".dagit", "following.json"), "utf-8");
    const entries = JSON.parse(raw);
    return entries.map((e: any) => ({
      did: e.did ?? "",
      alias: e.alias ?? e.name ?? "",
      cids: e.lastSeenCids ?? [],
    }));
  } catch {
    return [];
  }
}

// --- Petname generator (deterministic, matches dagit/feed.py) ---

const ADJECTIVES = [
  "amber", "azure", "bold", "bright", "calm", "clear", "cool", "coral",
  "crimson", "dark", "deep", "dry", "dusk", "faint", "fast", "firm",
  "gold", "green", "grey", "haze", "iron", "keen", "kind", "late",
  "light", "live", "long", "loud", "low", "mild", "mint", "mist",
  "moss", "near", "new", "next", "north", "odd", "old", "open",
  "pale", "pine", "plain", "proud", "pure", "quick", "quiet", "rare",
  "raw", "red", "rich", "sage", "salt", "sand", "sharp", "shy",
  "silk", "slim", "slow", "soft", "south", "steel", "still", "stone",
];

const NOUNS = [
  "ash", "bay", "birch", "bloom", "brook", "cave", "cedar", "cliff",
  "cloud", "coal", "cove", "crane", "creek", "crow", "dawn", "deer",
  "dove", "dune", "dusk", "eagle", "elm", "ember", "fern", "finch",
  "fire", "flint", "fox", "frost", "gale", "glen", "grove", "hawk",
  "haze", "heath", "heron", "hill", "ivy", "jade", "jay", "lake",
  "lark", "leaf", "marsh", "mesa", "moon", "oak", "owl", "peak",
  "pine", "pond", "rain", "reed", "ridge", "rock", "rose", "sage",
  "shade", "shore", "sky", "snow", "star", "storm", "stone", "vale",
];

function petname(did: string): string {
  const h = createHash("sha256").update(did).digest();
  return `${ADJECTIVES[h[0] % ADJECTIVES.length]}-${NOUNS[h[1] % NOUNS.length]}`;
}

// --- Tool Definitions (Responses API format) ---

export const TOOL_DEFS: any[] = [
  // Memex tools
  {
    type: "function",
    name: "memex_search",
    description: "Full-text keyword search across all nodes in the knowledge graph. Searches content and metadata. Use short keyword queries (e.g. 'machine learning', 'Alice'). Returns node IDs, types, and labels — call memex_get_node to read full content.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keywords (e.g. 'neural networks', 'project alpha')" },
        limit: { type: "integer", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_get_node",
    description: "Get full details of a node: type, metadata, and content. Use after memex_search to read a specific result.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node ID (e.g. 'person:a1b2c3d4', 'sha256:abc...')" },
      },
      required: ["id"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_get_links",
    description: "Get all incoming and outgoing relationships for a node. Returns edges like: --[mentions]--> target or <--[authored_by]-- source. Common link types: related_to, mentions, authored_by, extracted_from, part_of.",
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
    description: "Breadth-first traversal from a starting node, following outgoing links. Returns all reachable nodes within depth. Use to map a node's neighborhood. For deeper exploration with synthesis, prefer graph_explore.",
    parameters: {
      type: "object",
      properties: {
        start: { type: "string", description: "Starting node ID" },
        depth: { type: "integer", description: "Max hops to follow (default 2, max useful ~4)" },
      },
      required: ["start"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_filter",
    description: "List all nodes of a given type. Returns node IDs only. Valid types: Note, Person, Concept, Document, Source, Lens, Claim, Reference.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type (e.g. 'Person', 'Note', 'Concept', 'Source')" },
        limit: { type: "integer", description: "Max results (default 20)" },
      },
      required: ["type"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_create_node",
    description: "Create a new node in the knowledge graph. The node ID is auto-generated as 'type:hash8'. Use memex_create_link afterward to connect it to related nodes.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type: Note, Person, Concept, Document, Claim, Reference, Lens" },
        content: { type: "string", description: "Main content body of the node" },
        title: { type: "string", description: "Short title or name (stored in metadata)" },
      },
      required: ["type", "content"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_ingest",
    description: "Ingest raw content as a content-addressed Source node (ID: sha256:hash). Use for articles, web pages, documents, or any raw text. Automatically deduplicates — ingesting the same content twice returns the existing node. Prefer memex_create_node for structured entities; use this for raw source material.",
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
    name: "memex_ingest_url",
    description: "Fetch a web page by URL and ingest as a Source node. Strips HTML, extracts title, deduplicates by content hash. Use when the user wants to save an article, blog post, or web page.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full URL to fetch (https://...)" },
      },
      required: ["url"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_update_node",
    description: "Update an existing node's metadata fields (title, name, tags, etc.). Merges with existing metadata — only specified fields are changed. Does NOT update the node's content body.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Node ID to update" },
        meta: { type: "object", description: "Metadata fields to set or update (e.g. {\"title\": \"New Title\", \"tags\": [\"ai\"]})" },
      },
      required: ["id", "meta"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "memex_create_link",
    description: "Create a directed relationship between two nodes. Idempotent — creating the same link twice is safe. Common types: related_to, mentions, authored_by, part_of, extracted_from, references.",
    parameters: {
      type: "object",
      properties: {
        source: { type: "string", description: "Source node ID (the 'from' end)" },
        target: { type: "string", description: "Target node ID (the 'to' end)" },
        type: { type: "string", description: "Relationship type (e.g. 'related_to', 'mentions', 'authored_by')" },
      },
      required: ["source", "target", "type"],
    },
    strict: false,
  },
  // Graph exploration
  {
    type: "function",
    name: "graph_explore",
    description: "Deep autonomous exploration of the knowledge graph. A sub-agent recursively searches, reads full content, follows links, and synthesizes a comprehensive answer. Use for complex questions like 'what do I know about X?', 'summarize everything related to Y', or 'how are A and B connected?'. Slower than memex_search but much more thorough.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to answer by exploring the graph" },
      },
      required: ["question"],
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
    description: "Post a message to the dagit network. Signs with your identity, publishes to IPFS, and saves as a Post node in your graph. When composing posts informed by existing knowledge, use [[node-id]] to reference source nodes.",
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
  // Dagit follow/feed tools
  {
    type: "function",
    name: "dagit_follow",
    description: "Follow a person by their DID. Their posts become discoverable via IPNS feed resolution.",
    parameters: {
      type: "object",
      properties: {
        did: { type: "string", description: "The DID (did:key:z...) of the person to follow" },
        alias: { type: "string", description: "Optional friendly name for this person" },
      },
      required: ["did"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_unfollow",
    description: "Unfollow a person by their DID",
    parameters: {
      type: "object",
      properties: {
        did: { type: "string", description: "The DID of the person to unfollow" },
      },
      required: ["did"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_following",
    description: "List all followed DIDs and their feed status",
    parameters: { type: "object", properties: {}, required: [] },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_check_feeds",
    description: "Poll all followed feeds via IPNS, fetch new posts, verify signatures, and ingest into the knowledge graph",
    parameters: { type: "object", properties: {}, required: [] },
    strict: false,
  },
  {
    type: "function",
    name: "dagit_register",
    description: "Register your DID with a community supernode so it polls your feed and includes your posts in the curated community feed",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "The supernode URL (e.g. http://localhost:5000)" },
      },
      required: ["server"],
    },
    strict: false,
  },
  // Email tools
  {
    type: "function",
    name: "email_status",
    description: "Check email integration status: whether configured, connection health, domain filters, last check time",
    parameters: { type: "object", properties: {}, required: [] },
    strict: false,
  },
  {
    type: "function",
    name: "email_configure",
    description: "Configure email integration: set IMAP credentials, add/remove domain filters, enable/disable. Use action 'set_credentials' to save IMAP login, 'add_filter'/'remove_filter' to manage domain filters, 'enable'/'disable' to toggle.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action: set_credentials, add_filter, remove_filter, enable, disable" },
        host: { type: "string", description: "IMAP host (e.g. imap.gmail.com)" },
        port: { type: "integer", description: "IMAP port (default 993)" },
        user: { type: "string", description: "Email address / username" },
        pass: { type: "string", description: "Password or app password" },
        tls: { type: "boolean", description: "Use TLS (default true)" },
        filter: { type: "string", description: "Domain filter pattern for add_filter/remove_filter (e.g. *.substack.com)" },
      },
      required: ["action"],
    },
    strict: false,
  },
  {
    type: "function",
    name: "email_check_now",
    description: "Immediately poll for new emails matching domain filters, ingest them, and extract noteworthy entities using LLM",
    parameters: { type: "object", properties: {}, required: [] },
    strict: false,
  },
];

// --- Tool Execution ---

export async function executeTool(name: string, args: Record<string, any>): Promise<string> {
  try {
    if (name === "graph_explore") return await exploreGraph(args.question);
    if (name.startsWith("dagit_")) return await executeDagit(name, args);
    if (name.startsWith("memex_")) return executeMemex(name, args);
    if (name.startsWith("email_")) return await executeEmail(name, args);
    return `Unknown tool: ${name}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

async function executeMemex(name: string, args: Record<string, any>): Promise<string> {
  const mount = getMountPath();

  switch (name) {
    case "memex_search": {
      const nodeIds = fsSearchNodes(args.query, args.limit ?? 10);
      if (!nodeIds.length) return `No results for '${args.query}'`;
      const lines = [`Found ${nodeIds.length} results:`];
      for (const nid of nodeIds) {
        const node = fsReadNode(nid);
        if (!node) continue;
        const label = node.meta.name ?? node.meta.title ?? nid;
        lines.push(`  [${node.type}] ${label} (id: ${nid})`);
      }
      return lines.join("\n");
    }

    case "memex_get_node": {
      const node = fsReadNode(args.id);
      if (!node) return `Node not found: ${args.id}`;
      const lines = [`Node: ${args.id}`, `  Type: ${node.type}`];
      for (const [k, v] of Object.entries(node.meta)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          lines.push(`  ${k}: ${v}`);
        }
      }
      if (node.content) {
        const content = node.content.length > 4000
          ? node.content.slice(0, 4000) + "\n[...truncated]"
          : node.content;
        lines.push(`  Content:\n${content}`);
      }
      return lines.join("\n");
    }

    case "memex_get_links": {
      const links = fsReadAllLinks(args.id);
      if (!links.length) return `No links for ${args.id}`;

      const lines = [`Links for ${args.id} (${links.length}):`];
      for (const link of links.slice(0, 20)) {
        if (link.source === args.id) {
          lines.push(`  --[${link.type}]--> ${link.target}`);
        } else {
          lines.push(`  <--[${link.type}]-- ${link.source}`);
        }
      }
      if (links.length > 20) lines.push(`  ... and ${links.length - 20} more`);
      return lines.join("\n");
    }

    case "memex_traverse": {
      const maxDepth = args.depth ?? 2;
      const visited = new Set<string>();
      const edges: LinkData[] = [];
      const queue: Array<{ id: string; depth: number }> = [{ id: args.start, depth: 0 }];

      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);

        if (depth < maxDepth) {
          const links = fsReadOutgoingLinks(id);
          for (const link of links) {
            edges.push(link);
            if (!visited.has(link.target)) {
              queue.push({ id: link.target, depth: depth + 1 });
            }
          }
        }
      }

      if (visited.size === 0) return `No nodes from ${args.start}`;

      const lines = [`Traversal from ${args.start}: ${visited.size} nodes, ${edges.length} edges`];
      let count = 0;
      for (const nid of visited) {
        if (count >= 10) break;
        const node = fsReadNode(nid);
        if (!node) continue;
        const label = node.meta.name ?? node.meta.title ?? nid;
        lines.push(`  [${node.type}] ${label}`);
        count++;
      }
      if (visited.size > 10) lines.push(`  ... and ${visited.size - 10} more`);
      return lines.join("\n");
    }

    case "memex_filter": {
      const limit = args.limit ?? 20;
      try {
        const entries = readdirSync(join(mount, "types", args.type));
        if (!entries.length) return `No ${args.type} nodes found`;
        const limited = entries.slice(0, limit);
        const lines = [`${args.type} nodes (${entries.length}):`];
        for (const nid of limited) {
          lines.push(`  ${nid}`);
        }
        return lines.join("\n");
      } catch {
        return `No ${args.type} nodes found`;
      }
    }

    case "memex_create_node": {
      const ntype = args.type ?? "Note";
      const content = args.content ?? "";
      const title = args.title ?? "";

      const prefix = ntype.toLowerCase();
      const hashInput = `${content}${title}${Date.now()}`;
      const shortHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
      const nodeId = `${prefix}:${shortHash}`;

      const meta: Record<string, any> = {};
      if (title) meta.title = title;

      fsCreateNode(nodeId, content, meta);

      // Auto-link inline refs
      for (const ref of extractInlineRefs(content)) {
        if (fsReadNode(ref)) fsCreateLink(nodeId, ref, "references");
      }

      return `Created ${ntype} node: ${nodeId}`;
    }

    case "memex_ingest": {
      const content = args.content ?? "";
      const format = args.format ?? "text";
      if (!content) return "Error: content is required";

      const hash = createHash("sha256").update(content).digest("hex");
      const nodeId = `sha256:${hash}`;

      // Dedup: check if already exists
      const nodeDir = join(mount, "nodes", nodeId);
      try {
        statSync(nodeDir);
        return `Already ingested as ${nodeId}`;
      } catch {}

      const meta: Record<string, any> = {
        format,
        ingested_at: new Date().toISOString(),
      };

      fsCreateNode(nodeId, content, meta);

      // Auto-link inline refs
      for (const ref of extractInlineRefs(content)) {
        if (fsReadNode(ref)) fsCreateLink(nodeId, ref, "references");
      }

      return `Ingested as ${nodeId}`;
    }

    case "memex_ingest_url": {
      const url = args.url ?? "";
      if (!url) return "Error: url is required";

      let html: string;
      try {
        const resp = await fetch(url, {
          headers: { "User-Agent": "memex/0.2" },
          redirect: "follow",
        });
        if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;
        html = await resp.text();
      } catch (e: any) {
        return `Error: could not fetch ${url} — ${e.message}`;
      }

      // Extract title before stripping
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Strip HTML to plain text
      const content = stripHtml(html);
      if (!content || content.length < 20) return "Error: page returned no meaningful content";

      // Content-addressed dedup
      const hash = createHash("sha256").update(content).digest("hex");
      const nodeId = `sha256:${hash}`;
      const nodeDir = join(mount, "nodes", nodeId);
      try { statSync(nodeDir); return `Already ingested as ${nodeId}`; } catch {}

      const meta: Record<string, any> = {
        format: "html",
        url,
        ingested_at: new Date().toISOString(),
      };
      if (title) meta.title = title;

      fsCreateNode(nodeId, content, meta);

      // Auto-link inline refs
      for (const ref of extractInlineRefs(content)) {
        if (fsReadNode(ref)) fsCreateLink(nodeId, ref, "references");
      }

      return `Ingested "${title || url}" as ${nodeId} (${content.length} chars)`;
    }

    case "memex_update_node": {
      if (!args.id) return "Error: id is required";
      const nodeDir = join(mount, "nodes", args.id);
      try {
        const existingRaw = readFileSync(join(nodeDir, "meta.json"), "utf-8");
        const existing = JSON.parse(existingRaw);
        const merged = { ...existing, ...(args.meta ?? {}) };
        writeFileSync(join(nodeDir, "meta.json"), JSON.stringify(merged, null, 2) + "\n");
        return `Updated node: ${args.id}`;
      } catch {
        return `Node not found: ${args.id}`;
      }
    }

    case "memex_create_link": {
      if (!args.source || !args.target) return "Error: source and target are required";
      const linkType = args.type ?? "related_to";
      fsCreateLink(args.source, args.target, linkType);
      return `Created link: ${args.source} --[${linkType}]--> ${args.target}`;
    }

    default:
      return `Unknown memex tool: ${name}`;
  }
}

function runDagitCli(args: string[], timeoutMs = 60000): string {
  const result = Bun.spawnSync(["dagit", ...args], {
    stdout: "pipe", stderr: "pipe",
    timeout: timeoutMs,
  });
  const out = new TextDecoder().decode(result.stdout).trim();
  const err = new TextDecoder().decode(result.stderr).trim();
  if (result.exitCode !== 0) throw new Error(err || out || `dagit ${args[0]} failed`);
  return out;
}

function runDagitPython(code: string): void {
  Bun.spawnSync(["python3", "-c", code], { stdout: "ignore", stderr: "ignore" });
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
      // Update IPNS feed index (fire-and-forget)
      runDagitPython(`from dagit.feed import publish_feed; publish_feed("${cid}")`);

      // Ingest post into graph
      const postId = `post:${cid.slice(0, 8)}`;
      const ident = await identity.loadIdentity();
      fsCreateNode(postId, args.content, {
        cid,
        author_did: ident?.did ?? "",
        tags: args.tags ?? [],
        timestamp: new Date().toISOString(),
        published_by_me: true,
      });
      if (ident?.did) {
        const personId = `person:${createHash("sha256").update(ident.did).digest("hex").slice(0, 8)}`;
        try { fsCreateLink(postId, personId, "authored_by"); } catch {}
      }
      for (const ref of extractInlineRefs(args.content)) {
        if (fsReadNode(ref)) fsCreateLink(postId, ref, "references");
      }

      return JSON.stringify({ cid, postId, content: args.content, refs: args.refs, tags: args.tags }, null, 2);
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
      runDagitPython(`from dagit.feed import publish_feed; publish_feed("${replyCid}")`);

      // Ingest reply into graph
      const replyPostId = `post:${replyCid.slice(0, 8)}`;
      const replyIdent = await identity.loadIdentity();
      fsCreateNode(replyPostId, args.content, {
        cid: replyCid,
        author_did: replyIdent?.did ?? "",
        tags: args.tags ?? [],
        timestamp: new Date().toISOString(),
        published_by_me: true,
      });
      if (replyIdent?.did) {
        const personId = `person:${createHash("sha256").update(replyIdent.did).digest("hex").slice(0, 8)}`;
        try { fsCreateLink(replyPostId, personId, "authored_by"); } catch {}
      }
      // Link to parent post
      const parentPostId = `post:${args.cid.slice(0, 8)}`;
      if (fsReadNode(parentPostId)) {
        try { fsCreateLink(replyPostId, parentPostId, "reply_to"); } catch {}
      }
      for (const ref of extractInlineRefs(args.content)) {
        if (fsReadNode(ref)) fsCreateLink(replyPostId, ref, "references");
      }

      return JSON.stringify({ cid: replyCid, postId: replyPostId, refs: [args.cid], tags: args.tags, content: args.content }, null, 2);
    }

    case "dagit_verify": {
      if (!args.cid) return "Error: CID is required";
      if (!(await ipfs.isAvailable())) return "Error: IPFS daemon not available";
      const [post, verified] = await messages.fetchPost(args.cid);
      return JSON.stringify({ verified, author: post.author, cid: args.cid }, null, 2);
    }

    case "dagit_follow": {
      if (!args.did) return "Error: DID is required";
      const alias = args.alias || petname(args.did);
      const cliArgs = ["follow", args.did, "--name", alias];
      const result = runDagitCli(cliArgs);
      if (result.startsWith("Error") || result.startsWith("Already")) return result;

      // Create Person node in graph so memex_search can find them by name
      const nodeId = `person:${createHash("sha256").update(args.did).digest("hex").slice(0, 8)}`;
      try {
        fsCreateNode(nodeId, "", { name: alias, did: args.did });
      } catch {}

      return result;
    }

    case "dagit_unfollow": {
      if (!args.did) return "Error: DID is required";
      return runDagitCli(["unfollow", args.did]);
    }

    case "dagit_following": {
      return runDagitCli(["following"]);
    }

    case "dagit_check_feeds": {
      if (!(await ipfs.isAvailable())) return "Error: IPFS daemon not available";

      // Snapshot known CIDs before check
      const beforeCids = readFollowingCids();

      // Run Python feed check (resolves IPNS, updates following.json)
      const summary = runDagitCli(["check-feeds"]);

      // Snapshot CIDs after check — find new posts
      const afterCids = readFollowingCids();
      const newPosts: Array<{ did: string; alias: string; cid: string }> = [];
      for (const entry of afterCids) {
        const before = beforeCids.find(e => e.did === entry.did);
        const knownSet = new Set(before?.cids ?? []);
        for (const c of entry.cids) {
          if (!knownSet.has(c)) {
            newPosts.push({ did: entry.did, alias: entry.alias, cid: c });
          }
        }
      }

      // Fetch and ingest each new post
      const ingested: string[] = [];
      for (const np of newPosts) {
        try {
          const [feedPost, feedVerified] = await messages.fetchPost(np.cid);
          if (!feedVerified) continue;

          const feedPostId = `post:${np.cid.slice(0, 8)}`;
          if (fsReadNode(feedPostId)) continue; // already ingested

          fsCreateNode(feedPostId, feedPost.content, {
            cid: np.cid,
            author_did: feedPost.author,
            tags: feedPost.tags ?? [],
            timestamp: feedPost.timestamp,
            published_by_me: false,
            verified: true,
          });

          // Link to author Person node
          const feedPersonId = `person:${createHash("sha256").update(np.did).digest("hex").slice(0, 8)}`;
          try { fsCreateLink(feedPostId, feedPersonId, "authored_by"); } catch {}

          // Link refs as reply_to
          for (const ref of (feedPost.refs ?? [])) {
            const refPostId = `post:${ref.slice(0, 8)}`;
            if (fsReadNode(refPostId)) {
              try { fsCreateLink(feedPostId, refPostId, "reply_to"); } catch {}
            }
          }

          ingested.push(`  [Post] ${np.alias}: "${feedPost.content.slice(0, 80)}" (${feedPostId})`);
        } catch {}
      }

      if (!ingested.length) return summary;
      return summary + "\n\nIngested into graph:\n" + ingested.join("\n");
    }

    case "dagit_register": {
      if (!args.server) return "Error: server URL is required";
      const ident = await identity.loadIdentity();
      if (!ident) return "Error: No identity found. Initialize first.";
      const url = args.server.replace(/\/+$/, "") + "/register";
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ did: ident.did }),
        });
        const body = await resp.json();
        if (!resp.ok) return `Error: ${body.error ?? resp.statusText}`;
        return JSON.stringify(body, null, 2);
      } catch (e: any) {
        return `Error: could not reach ${url} — ${e.message}`;
      }
    }

    default:
      return `Unknown dagit tool: ${name}`;
  }
}

// --- Email tool execution ---

async function executeEmail(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "email_status": {
      const config = email.loadConfig();
      const configured = !!(config.credentials);
      const lines = [
        `Configured: ${configured}`,
        `Enabled: ${config.enabled}`,
        `Filters: ${config.filters.length ? config.filters.join(", ") : "(none — all emails accepted)"}`,
        `Mailbox: ${config.mailbox ?? "INBOX"}`,
      ];
      if (config.lastCheckedUid != null) {
        lines.push(`Last checked UID: ${config.lastCheckedUid}`);
      }
      if (configured && config.enabled) {
        const result = await email.testConnection(config.credentials!);
        lines.push(`Connection: ${result.ok ? "OK" : "FAILED — " + result.error}`);
      }
      return lines.join("\n");
    }

    case "email_configure": {
      const config = email.loadConfig();
      const action = args.action ?? "";

      switch (action) {
        case "set_credentials": {
          if (!args.host || !args.user || !args.pass) {
            return "Error: host, user, and pass are required for set_credentials";
          }
          const creds: email.EmailCreds = {
            host: args.host,
            port: args.port ?? 993,
            user: args.user,
            pass: args.pass,
            tls: args.tls ?? true,
          };
          // Test connection before saving
          const result = await email.testConnection(creds);
          if (!result.ok) {
            return `Connection failed: ${result.error}\nCredentials were NOT saved.`;
          }
          config.credentials = creds;
          config.enabled = true;
          email.saveConfig(config);
          return `Connected successfully! Credentials saved.\nUser: ${creds.user}\nHost: ${creds.host}:${creds.port}\nFilters: ${config.filters.join(", ")}\nEmail integration is now enabled.`;
        }

        case "add_filter": {
          const pattern = args.filter;
          if (!pattern) return "Error: filter pattern is required";
          if (!config.filters.includes(pattern)) {
            config.filters.push(pattern);
            email.saveConfig(config);
          }
          return `Filters: ${config.filters.join(", ")}`;
        }

        case "remove_filter": {
          const pattern = args.filter;
          if (!pattern) return "Error: filter pattern is required";
          config.filters = config.filters.filter(f => f !== pattern);
          email.saveConfig(config);
          return `Filters: ${config.filters.length ? config.filters.join(", ") : "(none — all emails accepted)"}`;
        }

        case "enable": {
          if (!config.credentials) return "Error: configure credentials first";
          config.enabled = true;
          email.saveConfig(config);
          return "Email integration enabled.";
        }

        case "disable": {
          config.enabled = false;
          email.saveConfig(config);
          return "Email integration disabled.";
        }

        default:
          return `Unknown action: ${action}. Use: set_credentials, add_filter, remove_filter, enable, disable`;
      }
    }

    case "email_check_now": {
      if (!email.isConfigured()) {
        return "Email not configured. Use email_configure to set up IMAP credentials first.";
      }
      try {
        const result = await ingestNewEmails();
        if (result.emailsFound === 0) {
          return "No new matching emails found.";
        }
        const lines = [
          `Found ${result.emailsFound} new emails, created ${result.extractionsCreated} extractions:`,
        ];
        for (const ext of result.extractions) {
          lines.push(`  [${ext.type}] ${ext.title} (${ext.nodeId})`);
        }
        lines.push("");
        lines.push("Search the graph for connections between these new extractions and existing knowledge, then brief the user.");
        return lines.join("\n");
      } catch (e: any) {
        return `Email check failed: ${e.message}`;
      }
    }

    default:
      return `Unknown email tool: ${name}`;
  }
}

// --- Conversation helpers ---

const CREDENTIAL_PATTERN = /password|app.?password|imap.*pass/i;

export function ingestConversationTurn(
  userMsg: string,
  assistantMsg: string,
  toolCalls?: string[],
): string | null {
  // Skip ingestion when email_configure was called (prevents passwords from entering the graph)
  if (toolCalls?.some(tc => tc === "email_configure")) return null;
  // Also skip if user message looks like it contains credentials
  if (CREDENTIAL_PATTERN.test(userMsg)) return null;

  const parts = [`User: ${userMsg}`, ""];
  if (toolCalls?.length) {
    for (const tc of toolCalls) parts.push(`  [${tc}]`);
    parts.push("");
  }
  parts.push(`Memex: ${assistantMsg}`);

  const content = parts.join("\n");

  try {
    const mount = getMountPath();
    const hash = createHash("sha256").update(content).digest("hex");
    const nodeId = `sha256:${hash}`;

    // Dedup
    const nodeDir = join(mount, "nodes", nodeId);
    try {
      statSync(nodeDir);
      return nodeId; // already exists
    } catch {}

    fsCreateNode(nodeId, content, {
      format: "conversation",
      ingested_at: new Date().toISOString(),
    });
    return nodeId;
  } catch {
    return null;
  }
}

export function loadRecentConversations(limit = 20): Array<{ role: string; content: string }> {
  try {
    const mount = getMountPath();
    let sourceIds: string[];
    try {
      sourceIds = readdirSync(join(mount, "types", "Source"));
    } catch {
      return [];
    }

    const conversations: Array<{ id: string; content: string; ingested_at: string }> = [];

    for (const nid of sourceIds) {
      const node = fsReadNode(nid);
      if (!node) continue;
      if (node.meta.format !== "conversation") continue;
      if (!node.content) continue;

      conversations.push({
        id: nid,
        content: node.content,
        ingested_at: node.meta.ingested_at ?? "",
      });
    }

    // Sort oldest first
    conversations.sort((a, b) => a.ingested_at.localeCompare(b.ingested_at));

    // Take most recent
    const recent = conversations.slice(-limit);

    // Parse back into message pairs
    const msgs: Array<{ role: string; content: string }> = [];
    for (const conv of recent) {
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
