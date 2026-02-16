/**
 * RLM-style graph exploration: sub-LLM recursively searches, reads, follows links, and synthesizes.
 */

function getMemexUrl(): string {
  return process.env.MEMEX_URL ?? "http://localhost:8080";
}

// --- Types ---

interface NodeData {
  id: string;
  type: string;
  meta: Record<string, any>;
  content: string;
}

interface LinkData {
  source: string;
  target: string;
  type: string;
}

interface Finding {
  nodeId: string;
  relevance: string;
  summary: string;
}

// --- Graph API helpers ---

async function apiSearch(query: string, limit = 10): Promise<NodeData[]> {
  const url = getMemexUrl();
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  try {
    const resp = await fetch(`${url}/api/query/search?${params}`, { signal: AbortSignal.timeout(10000) });
    if (resp.status !== 200) return [];
    const data = await resp.json() as any;
    const nodes = data.nodes ?? [];
    return nodes.map((n: any) => {
      const raw = n.Content ?? "";
      let content = "";
      if (raw) {
        try {
          content = Buffer.from(raw, "base64").toString("utf-8");
        } catch {
          content = typeof raw === "string" ? raw : "";
        }
      }
      return {
        id: n.ID ?? "",
        type: n.Type ?? "",
        meta: n.Meta ?? {},
        content,
      };
    });
  } catch {
    return [];
  }
}

async function apiGetNode(id: string): Promise<NodeData | null> {
  const url = getMemexUrl();
  try {
    const resp = await fetch(`${url}/api/nodes/${id}`, { signal: AbortSignal.timeout(10000) });
    if (resp.status !== 200) return null;
    const n = await resp.json() as any;
    const raw = n.Content ?? "";
    let content = "";
    if (raw) {
      try {
        content = Buffer.from(raw, "base64").toString("utf-8");
      } catch {
        content = typeof raw === "string" ? raw : "";
      }
    }
    return {
      id: n.ID ?? id,
      type: n.Type ?? "",
      meta: n.Meta ?? {},
      content,
    };
  } catch {
    return null;
  }
}

async function apiGetLinks(id: string): Promise<LinkData[]> {
  const url = getMemexUrl();
  try {
    const resp = await fetch(`${url}/api/nodes/${id}/links`, { signal: AbortSignal.timeout(10000) });
    if (resp.status !== 200) return [];
    const data = await resp.json() as any;
    const links: any[] = Array.isArray(data) ? data : (data.links ?? []);
    return links.map((l: any) => ({
      source: l.Source ?? l.source ?? "",
      target: l.Target ?? l.target ?? "",
      type: l.Type ?? l.type ?? "",
    }));
  } catch {
    return [];
  }
}

// --- Sub-LLM tool definitions (Chat Completions format) ---

const SUB_LLM_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_node",
      description: "Fetch full content of a node by ID",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Node ID to read" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_graph",
      description: "Full-text search across the knowledge graph",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search terms" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "follow_links",
      description: "Get all edges/relationships for a node",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Node ID to get links for" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "report_finding",
      description: "Mark a node as relevant to the question with a summary",
      parameters: {
        type: "object",
        properties: {
          nodeId: { type: "string", description: "The relevant node ID" },
          relevance: { type: "string", description: "Why this node is relevant (high/medium/low)" },
          summary: { type: "string", description: "Brief summary of what this node contributes to the answer" },
        },
        required: ["nodeId", "relevance", "summary"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "stop_exploring",
      description: "Stop exploration — you have enough information or no leads remain",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", description: "Why you're stopping" },
        },
        required: ["reason"],
      },
    },
  },
];

// --- Sub-LLM tool execution ---

async function executeSubTool(
  name: string,
  args: Record<string, any>,
  budget: { readsLeft: number },
  findings: Finding[],
): Promise<{ result: string; stop: boolean }> {
  switch (name) {
    case "read_node": {
      if (budget.readsLeft <= 0) return { result: "Budget exhausted — no reads remaining.", stop: false };
      budget.readsLeft--;
      const node = await apiGetNode(args.id);
      if (!node) return { result: `Node not found: ${args.id}`, stop: false };
      const content = node.content.length > 2000 ? node.content.slice(0, 2000) + "\n[...truncated]" : node.content;
      const metaLines = Object.entries(node.meta)
        .filter(([, v]) => typeof v === "string" || typeof v === "number")
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");
      return {
        result: `Node ${node.id} [${node.type}]\nMeta:\n${metaLines}\nContent:\n${content}`,
        stop: false,
      };
    }

    case "search_graph": {
      const results = await apiSearch(args.query, 10);
      if (!results.length) return { result: `No results for "${args.query}"`, stop: false };
      const lines = results.map(n => {
        const label = n.meta.name ?? n.meta.title ?? n.id;
        const snippet = n.content.slice(0, 150).replace(/\n/g, " ");
        return `  [${n.type}] ${label} (id: ${n.id})${snippet ? ` — ${snippet}` : ""}`;
      });
      return { result: `Search "${args.query}" — ${results.length} results:\n${lines.join("\n")}`, stop: false };
    }

    case "follow_links": {
      const links = await apiGetLinks(args.id);
      if (!links.length) return { result: `No links for ${args.id}`, stop: false };
      const lines = links.slice(0, 20).map(l => {
        if (l.source === args.id) return `  --[${l.type}]--> ${l.target}`;
        return `  <--[${l.type}]-- ${l.source}`;
      });
      if (links.length > 20) lines.push(`  ... and ${links.length - 20} more`);
      return { result: `Links for ${args.id} (${links.length}):\n${lines.join("\n")}`, stop: false };
    }

    case "report_finding": {
      findings.push({
        nodeId: args.nodeId ?? "",
        relevance: args.relevance ?? "medium",
        summary: args.summary ?? "",
      });
      return { result: `Finding recorded: ${args.nodeId} (${args.relevance})`, stop: false };
    }

    case "stop_exploring": {
      return { result: `Stopping: ${args.reason}`, stop: true };
    }

    default:
      return { result: `Unknown tool: ${name}`, stop: false };
  }
}

// --- Format initial search results for sub-LLM ---

function formatInitialResults(results: NodeData[]): string {
  return results.map(n => {
    const label = n.meta.name ?? n.meta.title ?? n.id;
    const snippet = n.content.slice(0, 200).replace(/\n/g, " ");
    return `[${n.type}] ${label} (id: ${n.id})${snippet ? `\n  ${snippet}` : ""}`;
  }).join("\n");
}

// --- Main exploration function ---

export async function exploreGraph(question: string): Promise<string> {
  const MAX_READS = 30;
  const MAX_LLM_CALLS = 8;

  // Phase 1: Initial search
  const initialResults = await apiSearch(question, 10);
  if (!initialResults.length) return "No relevant nodes found in the knowledge graph.";

  const OpenAI = (await import("openai")).default;
  const client = new OpenAI();

  const budget = { readsLeft: MAX_READS };
  const findings: Finding[] = [];
  let llmCallsUsed = 0;

  // Phase 2: Sub-LLM exploration loop
  const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string }> = [
    {
      role: "system",
      content: `You are a knowledge graph explorer. Answer the user's question by navigating their personal knowledge graph.

Actions: read_node, search_graph, follow_links, report_finding, stop_exploring

Strategy:
- Read the most promising search results first
- Follow links to discover connections
- Call report_finding for anything relevant to the question
- Call stop_exploring when you have enough or no leads remain

Budget: ${MAX_READS} reads, ${MAX_LLM_CALLS} LLM calls remaining`,
    },
    {
      role: "user",
      content: `Question: ${question}\n\nInitial search results:\n${formatInitialResults(initialResults)}\n\nExplore these results to answer the question. Read promising nodes, follow links, and report findings.`,
    },
  ];

  let shouldStop = false;

  while (llmCallsUsed < MAX_LLM_CALLS && !shouldStop) {
    llmCallsUsed++;

    let response;
    try {
      response = await client.chat.completions.create({
        model: "gpt-4o-mini",
        messages: messages as any,
        tools: SUB_LLM_TOOLS,
        tool_choice: "auto",
        temperature: 0.2,
      });
    } catch {
      // Sub-LLM failure — synthesize what we have
      break;
    }

    const msg = response.choices[0]?.message;
    if (!msg) break;

    // Add assistant message to conversation
    messages.push(msg as any);

    // If no tool calls, the sub-LLM is done talking
    if (!msg.tool_calls?.length) {
      shouldStop = true;
      break;
    }

    // Execute each tool call and add results
    for (const tc of msg.tool_calls as any[]) {
      let args: Record<string, any> = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {}

      const { result, stop } = await executeSubTool(tc.function.name, args, budget, findings);

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
      });

      if (stop) shouldStop = true;
    }

    // Inject budget update as a short system-style note in the next user turn
    if (!shouldStop && llmCallsUsed < MAX_LLM_CALLS) {
      messages.push({
        role: "user",
        content: `[Budget: ${budget.readsLeft} reads, ${MAX_LLM_CALLS - llmCallsUsed} LLM calls remaining. ${findings.length} findings so far.]`,
      });
    }
  }

  // Phase 3: Synthesis
  if (!findings.length) {
    // No explicit findings — check if the sub-LLM gave a text response
    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant" && m.content);
    if (lastAssistant?.content) return lastAssistant.content;
    return "Explored the graph but found no relevant information for this question.";
  }

  const findingsSummary = findings.map((f, i) =>
    `${i + 1}. [${f.relevance}] Node ${f.nodeId}: ${f.summary}`
  ).join("\n");

  try {
    const synthesis = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "Synthesize the following findings from a knowledge graph exploration into a comprehensive answer. Include specifics — names, dates, key details. Note if information seems incomplete.",
        },
        {
          role: "user",
          content: `Question: ${question}\n\nFindings:\n${findingsSummary}`,
        },
      ],
      temperature: 0.3,
    });
    return synthesis.choices[0]?.message?.content ?? findingsSummary;
  } catch {
    // Synthesis failed — return raw findings
    return `Found ${findings.length} relevant items:\n${findingsSummary}`;
  }
}
