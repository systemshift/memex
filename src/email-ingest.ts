/**
 * LLM-driven email extraction pipeline.
 * Fetches new emails, ingests raw source, extracts entities via LLM using lenses + graph context.
 */

import { createHash } from "crypto";
import * as email from "./email";

function getMemexUrl(): string {
  return process.env.MEMEX_URL ?? "http://localhost:8080";
}

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

// --- Fetch lenses from graph ---

async function loadLenses(): Promise<Array<{ id: string; name: string; description: string }>> {
  try {
    const resp = await fetch(`${getMemexUrl()}/api/lenses`, { signal: AbortSignal.timeout(5000) });
    if (resp.status !== 200) return [];
    const data = await resp.json() as any;
    const lenses = Array.isArray(data) ? data : (data.lenses ?? []);
    return lenses.map((l: any) => ({
      id: l.ID ?? l.id ?? "",
      name: l.Meta?.name ?? l.name ?? "",
      description: l.Meta?.description ?? l.description ?? "",
    }));
  } catch {
    return [];
  }
}

// --- Fetch graph context via search ---

async function loadGraphContext(subject: string, from: string): Promise<string> {
  try {
    // Search for related content to give LLM context
    const queries = [subject.slice(0, 60), from.split("@")[0]].filter(Boolean);
    const results: string[] = [];

    for (const q of queries) {
      const params = new URLSearchParams({ q, limit: "5" });
      const resp = await fetch(`${getMemexUrl()}/api/query/search?${params}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.status !== 200) continue;
      const data = await resp.json() as any;
      const nodes = data.nodes ?? [];
      for (const n of nodes) {
        const meta = n.Meta ?? {};
        const label = meta.name ?? meta.title ?? n.ID;
        results.push(`[${n.Type}] ${label}`);
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

async function ingestRawEmail(parsed: email.ParsedEmail): Promise<string | null> {
  const body = parsed.textBody || stripHtml(parsed.htmlBody);
  const content = `From: ${parsed.from}\nSubject: ${parsed.subject}\nDate: ${parsed.date}\n\n${body}`;

  try {
    const resp = await fetch(`${getMemexUrl()}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, format: "email" }),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status === 200) {
      const data = await resp.json() as any;
      return data.source_id ?? null;
    }
  } catch {}
  return null;
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
      model: "gpt-4o-mini",
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

async function createExtractionNode(
  extraction: Extraction,
  sourceId: string,
): Promise<string | null> {
  const url = getMemexUrl();
  const prefix = extraction.type.toLowerCase();
  const hashInput = `${extraction.title}${extraction.content}${Date.now()}`;
  const shortHash = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
  const nodeId = `${prefix}:${shortHash}`;

  try {
    // Create the node
    const resp = await fetch(`${url}/api/nodes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: nodeId,
        type: extraction.type,
        meta: {
          title: extraction.title,
          content: extraction.content,
          extracted_from_email: true,
        },
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (resp.status !== 200 && resp.status !== 201) return null;

    // Link to source
    await fetch(`${url}/api/links`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: nodeId, target: sourceId, type: "EXTRACTED_FROM" }),
      signal: AbortSignal.timeout(5000),
    });

    // Link to lens if applicable
    if (extraction.lens) {
      await fetch(`${url}/api/links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: nodeId, target: extraction.lens, type: "INTERPRETED_THROUGH" }),
        signal: AbortSignal.timeout(5000),
      });
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
    const sourceId = await ingestRawEmail(parsed);
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
    const graphContext = await loadGraphContext(parsed.subject, parsed.from);

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
      const nodeId = await createExtractionNode(extraction, sourceId);
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
