/**
 * LLM-driven email extraction pipeline.
 * Fetches new emails, ingests raw source, extracts entities via LLM using lenses + graph context.
 */

import { createHash } from "crypto";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import * as email from "./email";
import {
  getMountPath,
  fsReadNode,
  fsSearchNodes,
  fsCreateNode,
  fsCreateLink,
} from "./tools";

// --- HTML stripping ---

export function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- Fetch lenses from FUSE mount ---

async function loadLenses(): Promise<Array<{ id: string; name: string; description: string }>> {
  const mount = getMountPath();
  try {
    const lensIds = readdirSync(join(mount, "lenses"));
    const lenses: Array<{ id: string; name: string; description: string }> = [];
    for (const lid of lensIds) {
      const node = fsReadNode(lid);
      if (!node) continue;
      lenses.push({
        id: lid,
        name: node.meta.name ?? "",
        description: node.meta.description ?? "",
      });
    }
    return lenses;
  } catch {
    return [];
  }
}

// --- Fetch graph context via search ---

function loadGraphContext(subject: string, from: string): string {
  try {
    const queries = [subject.slice(0, 60), from.split("@")[0]].filter(Boolean);
    const results: string[] = [];

    for (const q of queries) {
      const nodeIds = fsSearchNodes(q, 5);
      for (const nid of nodeIds) {
        const node = fsReadNode(nid);
        if (!node) continue;
        const label = node.meta.name ?? node.meta.title ?? nid;
        results.push(`[${node.type}] ${label}`);
      }
    }

    if (!results.length) return "No existing related nodes found.";
    const unique = [...new Set(results)];
    return "Existing related nodes:\n" + unique.slice(0, 10).map(r => `  - ${r}`).join("\n");
  } catch {
    return "Could not load graph context.";
  }
}

// --- Ingest raw email as Source node ---

function ingestRawEmail(parsed: email.ParsedEmail): string | null {
  const body = parsed.textBody || stripHtml(parsed.htmlBody);
  const content = `From: ${parsed.from}\nSubject: ${parsed.subject}\nDate: ${parsed.date}\n\n${body}`;

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
      format: "email",
      ingested_at: new Date().toISOString(),
    });
    return nodeId;
  } catch {
    return null;
  }
}

// --- LLM Extraction ---

interface Extraction {
  type: string;
  title: string;
  content: string;
  lens?: string; // lens ID it was interpreted through
}

export async function extractWithLlm(
  text: string,
  subject: string,
  from: string,
  lenses: Array<{ id: string; name: string; description: string }>,
  graphContext: string,
): Promise<Extraction[]> {
  const OpenAI = (await import("openai")).default;
  const client = new OpenAI();

  const lensSection = lenses.length
    ? "Active lenses (user-defined focus areas):\n" + lenses.map(l =>
        `  - ${l.name} (${l.id}): ${l.description}`
      ).join("\n")
    : "No active lenses. Use your own judgment about what's worth extracting.";

  // Truncate email text to avoid huge prompts
  const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n[...truncated]" : text;

  const systemPrompt = `You extract noteworthy entities from newsletter emails for a personal knowledge graph.

${lensSection}

${graphContext}

For each noteworthy concept, person, claim, or reference in the email, call the create_extraction tool.
Only extract things that are genuinely interesting or useful — not boilerplate, ads, or filler.
If a lens applies, set the lens field to that lens's ID.
Be selective: 2-5 extractions for a typical newsletter is ideal.`;

  const tools = [{
    type: "function" as const,
    function: {
      name: "create_extraction",
      description: "Create an extracted entity from the email",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", description: "Node type: Concept, Person, Claim, Reference, Note" },
          title: { type: "string", description: "Short title for the extraction" },
          content: { type: "string", description: "1-3 sentence summary of the extracted entity" },
          lens: { type: "string", description: "Lens ID if this was interpreted through a specific lens (optional)" },
        },
        required: ["type", "title", "content"],
      },
    },
  }];

  const extractions: Extraction[] = [];

  try {
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL_SUB ?? "gpt-5.4-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `From: ${from}\nSubject: ${subject}\n\n${truncated}` },
      ],
      tools,
      tool_choice: "auto",
      temperature: 0.3,
    });

    const msg = response.choices[0]?.message;
    if (msg?.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.function.name === "create_extraction") {
          try {
            const args = JSON.parse(tc.function.arguments);
            extractions.push({
              type: args.type ?? "Note",
              title: args.title ?? "",
              content: args.content ?? "",
              lens: args.lens,
            });
          } catch {}
        }
      }
    }
  } catch (e: any) {
    // LLM call failed — return empty extractions
  }

  return extractions;
}

// --- Create extraction nodes + links ---

function createExtractionNode(
  extraction: Extraction,
  sourceId: string,
): string | null {
  const prefix = extraction.type.toLowerCase();
  const hashInput = `${extraction.title}${extraction.content}${Date.now()}`;
  const shortHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
  const nodeId = `${prefix}:${shortHash}`;

  try {
    fsCreateNode(nodeId, extraction.content, {
      title: extraction.title,
      content: extraction.content,
      extracted_from_email: true,
    });

    // Link to source
    fsCreateLink(nodeId, sourceId, "EXTRACTED_FROM");

    // Link to lens if applicable
    if (extraction.lens) {
      fsCreateLink(nodeId, extraction.lens, "INTERPRETED_THROUGH");
    }

    return nodeId;
  } catch {
    return null;
  }
}

// --- Full Pipeline ---

export interface IngestProgress {
  phase: "fetching" | "ingesting" | "extracting" | "done";
  emailsFound: number;
  emailsProcessed: number;
  extractionsCreated: number;
}

export async function ingestNewEmails(
  onProgress?: (p: IngestProgress) => void,
): Promise<IngestProgress> {
  const config = email.loadConfig();
  if (!config.credentials || !config.enabled) {
    return { phase: "done", emailsFound: 0, emailsProcessed: 0, extractionsCreated: 0 };
  }

  const progress: IngestProgress = {
    phase: "fetching",
    emailsFound: 0,
    emailsProcessed: 0,
    extractionsCreated: 0,
  };
  onProgress?.(progress);

  // Fetch new emails
  const { emails, highestUid } = await email.fetchNewEmails(
    config.credentials,
    config.filters,
    config.lastCheckedUid,
    config.mailbox ?? "INBOX",
  );

  progress.emailsFound = emails.length;
  progress.phase = "ingesting";
  onProgress?.(progress);

  if (!emails.length) {
    progress.phase = "done";
    onProgress?.(progress);
    // Still update UID even if no matching emails
    if (highestUid > (config.lastCheckedUid ?? 0)) {
      config.lastCheckedUid = highestUid;
      email.saveConfig(config);
    }
    return progress;
  }

  // Load lenses + context
  const lenses = await loadLenses();

  for (const parsed of emails) {
    // Ingest raw email as Source node
    const sourceId = ingestRawEmail(parsed);
    if (!sourceId) {
      progress.emailsProcessed++;
      continue;
    }

    // Get email text for LLM
    const bodyText = parsed.textBody || stripHtml(parsed.htmlBody);
    if (!bodyText || bodyText.length < 50) {
      progress.emailsProcessed++;
      continue;
    }

    progress.phase = "extracting";
    onProgress?.(progress);

    // Load context relevant to this email
    const graphContext = loadGraphContext(parsed.subject, parsed.from);

    // Extract with LLM
    const extractions = await extractWithLlm(
      bodyText,
      parsed.subject,
      parsed.from,
      lenses,
      graphContext,
    );

    // Create nodes + links
    for (const extraction of extractions) {
      const nodeId = createExtractionNode(extraction, sourceId);
      if (nodeId) progress.extractionsCreated++;
    }

    progress.emailsProcessed++;
    onProgress?.(progress);
  }

  // Update lastCheckedUid
  if (highestUid > (config.lastCheckedUid ?? 0)) {
    config.lastCheckedUid = highestUid;
    email.saveConfig(config);
  }

  progress.phase = "done";
  onProgress?.(progress);
  return progress;
}
