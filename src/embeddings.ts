/**
 * Semantic search via OpenAI embeddings. Cached to disk, incremental updates.
 */

import { readFileSync, appendFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import { getDataPath, getMountPath, fsReadNode } from "./tools";

// --- Types ---

interface EmbeddingEntry {
  nodeId: string;
  vector: number[];
}

// --- Globals ---

let cache: Map<string, number[]> | null = null;
let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

function getCachePath(): string {
  return join(getDataPath(), ".mx", "embeddings.jsonl");
}

// --- Cache management ---

function loadCache(): Map<string, number[]> {
  const map = new Map<string, number[]>();
  const path = getCachePath();
  if (!existsSync(path)) return map;
  try {
    const raw = readFileSync(path, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry: EmbeddingEntry = JSON.parse(line);
        map.set(entry.nodeId, entry.vector);
      } catch {}
    }
  } catch {}
  return map;
}

function appendCache(nodeId: string, vector: number[]): void {
  const entry: EmbeddingEntry = { nodeId, vector };
  appendFileSync(getCachePath(), JSON.stringify(entry) + "\n");
}

// --- OpenAI API ---

async function embedTexts(texts: string[]): Promise<number[][]> {
  const resp = await getClient().embeddings.create({
    model: "text-embedding-3-small",
    input: texts,
  });
  return resp.data.map(d => d.embedding);
}

// --- Vector math ---

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// --- Search ---

export async function semanticSearch(query: string, topK = 10): Promise<string[]> {
  if (!cache || cache.size === 0) return [];
  try {
    const [queryVec] = await embedTexts([query]);
    const scored: Array<{ id: string; score: number }> = [];
    for (const [nodeId, vec] of cache) {
      scored.push({ id: nodeId, score: cosineSimilarity(queryVec, vec) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).filter(s => s.score > 0.2).map(s => s.id);
  } catch {
    return [];
  }
}

// --- Node text extraction ---

function nodeText(nodeId: string): string | null {
  const node = fsReadNode(nodeId);
  if (!node) return null;
  const parts: string[] = [];
  if (node.type) parts.push(node.type);
  if (node.meta.title) parts.push(node.meta.title);
  if (node.meta.name) parts.push(node.meta.name);
  if (node.content) parts.push(node.content);
  const text = parts.join(" ").trim();
  return text ? text.slice(0, 8000) : null;
}

// --- Lifecycle ---

export async function embedNode(nodeId: string): Promise<void> {
  if (!cache) cache = loadCache();
  if (cache.has(nodeId)) return;
  const text = nodeText(nodeId);
  if (!text) return;
  try {
    const [vec] = await embedTexts([text]);
    cache.set(nodeId, vec);
    appendCache(nodeId, vec);
  } catch {}
}

async function backfill(): Promise<number> {
  const mount = getMountPath();
  let allIds: string[];
  try {
    allIds = readdirSync(join(mount, "nodes"));
  } catch {
    return 0;
  }

  const missing = allIds.filter(id => !cache!.has(id));
  if (!missing.length) return 0;

  const BATCH = 50;
  let embedded = 0;

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const texts: string[] = [];
    const ids: string[] = [];

    for (const id of batch) {
      const text = nodeText(id);
      if (text) {
        texts.push(text);
        ids.push(id);
      }
    }

    if (!texts.length) continue;

    try {
      const vectors = await embedTexts(texts);
      for (let j = 0; j < ids.length; j++) {
        cache!.set(ids[j], vectors[j]);
        appendCache(ids[j], vectors[j]);
      }
      embedded += ids.length;
    } catch {
      break;
    }
  }

  return embedded;
}

export async function initEmbeddings(): Promise<void> {
  cache = loadCache();
  const count = await backfill();
  if (count > 0) {
    const { log } = await import("./services");
    log(`Embedded ${count} new nodes`);
  }
}
