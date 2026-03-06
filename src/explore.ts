/**
 * RLM-style graph exploration: sub-LLM recursively searches, reads, follows links, and synthesizes.
 */

import {
  fsReadNode,
  fsSearchNodes,
  fsReadAllLinks,
  type NodeData,
  type LinkData,
} from "./tools";

// --- Types ---

interface Finding {
  nodeId: string;
  relevance: string;
  summary: string;
}

// --- Graph FS helpers ---

function searchGraph(query: string, limit = 10): NodeData[] {
  const nodeIds = fsSearchNodes(query, limit);
  const results: NodeData[] = [];
  for (const nid of nodeIds) {
    const node = fsReadNode(nid);
    if (node) results.push(node);
  }
  return results;
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

function executeSubTool(
  name: string,
  args: Record<string, any>,
  budget: { readsLeft: number },
  findings: Finding[],
): { result: string; stop: boolean } {
  switch (name) {
    case "read_node": {
      if (budget.readsLeft <= 0) return { result: "Budget exhausted — no reads remaining.", stop: false };
      budget.readsLeft--;
      const node = fsReadNode(args.id);
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
      const results = searchGraph(args.query, 10);
      if (!results.length) return { result: `No results for "${args.query}"`, stop: false };
      const lines = results.map(n => {
        const label = n.meta.name ?? n.meta.title ?? n.id;
        const snippet = n.content.slice(0, 150).replace(/\n/g, " ");
        return `  [${n.type}] ${label} (id: ${n.id})${snippet ? ` — ${snippet}` : ""}`;
      });
      return { result: `Search "${args.query}" — ${results.length} results:\n${lines.join("\n")}`, stop: false };
    }

    case "follow_links": {
      const links = fsReadAllLinks(args.id);
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
  const initialResults = searchGraph(question, 10);
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
      content: `You are exploring a personal knowledge graph to answer a question. Navigate by reading nodes, searching, and following links.

Graph structure:
- Node types: Note, Person, Concept, Document, Source, Lens, Claim, Reference
- Node IDs: "type:hash8" (e.g. "person:a1b2c3d4") or "sha256:..." for ingested content
- Link types: related_to, mentions, authored_by, extracted_from, part_of, references
- Source nodes contain raw content (articles, conversations). Other nodes are structured entities.

Strategy:
1. Read the most promising search results first (read_node)
2. Follow links to discover connections (follow_links)
3. Try alternative search terms if initial results are sparse — synonyms, related concepts, partial names
4. Call report_finding for each relevant piece of information
5. Call stop_exploring when you have enough findings or no leads remain

Budget: ${MAX_READS} reads, ${MAX_LLM_CALLS} turns. Be efficient — read selectively, not exhaustively.`,
    },
    {
      role: "user",
      content: `Question: ${question}\n\nInitial search results:\n${formatInitialResults(initialResults)}\n\nExplore these to answer the question.`,
    },
  ];

  let shouldStop = false;

  while (llmCallsUsed < MAX_LLM_CALLS && !shouldStop) {
    llmCallsUsed++;

    let response;
    try {
      response = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL_SUB ?? "gpt-5.4-mini",
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

      const { result, stop } = executeSubTool(tc.function.name, args, budget, findings);

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: tc.id,
      });

      if (stop) shouldStop = true;
    }

    // Inject budget update as system context
    if (!shouldStop && llmCallsUsed < MAX_LLM_CALLS) {
      messages.push({
        role: "system",
        content: `Budget: ${budget.readsLeft} reads, ${MAX_LLM_CALLS - llmCallsUsed} turns remaining. ${findings.length} findings so far.`,
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
      model: process.env.OPENAI_MODEL_SUB ?? "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content: "Synthesize the following findings from a knowledge graph exploration into a concise answer. Include specifics — names, dates, key details. Note if information seems incomplete. Be direct, no preamble.",
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
