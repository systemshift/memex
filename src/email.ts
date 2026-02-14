/**
 * IMAP client + credential store for email integration.
 * Uses imapflow with dynamic import (lazy-loaded).
 * Bun #18492 workaround: search() + fetchOne() loop instead of async iterator.
 */

import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

// --- Types ---

export interface EmailCreds {
  host: string;
  port: number;
  user: string;
  pass: string;
  tls: boolean;
}

export interface EmailConfig {
  credentials?: EmailCreds;
  filters: string[];          // domain glob patterns, e.g. ["*.substack.com"]
  enabled: boolean;
  lastCheckedUid?: number;
  mailbox?: string;           // default "INBOX"
}

export interface ParsedEmail {
  uid: number;
  subject: string;
  from: string;
  fromDomain: string;
  date: string;
  textBody: string;
  htmlBody: string;
}

// --- Config ---

const CONFIG_DIR = join(homedir(), ".memex");
const CONFIG_PATH = join(CONFIG_DIR, "email.json");

const DEFAULT_CONFIG: EmailConfig = {
  filters: ["*.substack.com"],
  enabled: false,
};

export function loadConfig(): EmailConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

export function saveConfig(config: EmailConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

export function isConfigured(): boolean {
  const config = loadConfig();
  return !!(config.credentials && config.enabled);
}

// --- Connection Test ---

export async function testConnection(creds: EmailCreds): Promise<{ ok: boolean; error?: string }> {
  try {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: creds.host,
      port: creds.port,
      secure: creds.tls,
      auth: { user: creds.user, pass: creds.pass },
      logger: false,
    });
    await client.connect();
    await client.logout();
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// --- Domain Matching ---

export function matchGlob(domain: string, pattern: string): boolean {
  // Convert glob pattern to regex: *.substack.com → (.+\.)?substack\.com
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex chars except *
    .replace(/\\\*/g, ".*");                 // convert \* back to .*
  // But we escaped . in pattern, so *.substack.com → .*\.substack\.com — close enough
  // Actually let's redo more carefully:
  const regexStr = "^" + pattern
    .split("*").map(part => part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join(".*")
    + "$";
  return new RegExp(regexStr, "i").test(domain);
}

function domainFromAddress(addr: string): string {
  // "user@example.com" or "Name <user@example.com>"
  const match = addr.match(/@([^>]+)/);
  return match ? match[1].toLowerCase().trim() : "";
}

function matchesFilters(fromAddr: string, filters: string[]): boolean {
  if (!filters.length) return true; // no filters = accept all
  const domain = domainFromAddress(fromAddr);
  if (!domain) return false;
  return filters.some(pattern => matchGlob(domain, pattern));
}

// --- MIME Body Extraction (minimal, no mailparser) ---

function decodeMimeBody(body: string | Buffer, encoding?: string): string {
  if (Buffer.isBuffer(body)) {
    if (encoding === "base64") return Buffer.from(body.toString("ascii"), "base64").toString("utf-8");
    if (encoding === "quoted-printable") return decodeQuotedPrintable(body.toString("ascii"));
    return body.toString("utf-8");
  }
  if (typeof body === "string") {
    if (encoding === "base64") return Buffer.from(body, "base64").toString("utf-8");
    if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
    return body;
  }
  return "";
}

function decodeQuotedPrintable(str: string): string {
  return str
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// --- Fetch Emails ---

export async function fetchNewEmails(
  creds: EmailCreds,
  filters: string[],
  sinceUid?: number,
  mailbox = "INBOX",
  limit = 20,
): Promise<{ emails: ParsedEmail[]; highestUid: number }> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: creds.host,
    port: creds.port,
    secure: creds.tls,
    auth: { user: creds.user, pass: creds.pass },
    logger: false,
  });

  await client.connect();

  const emails: ParsedEmail[] = [];
  let highestUid = sinceUid ?? 0;

  try {
    const lock = await client.getMailboxLock(mailbox);
    try {
      // Search for messages newer than sinceUid
      const searchCriteria: any = sinceUid ? { uid: `${sinceUid + 1}:*` } : {};
      const uids = await client.search(searchCriteria, { uid: true });

      if (!uids || !uids.length) {
        return { emails, highestUid };
      }

      // Bun #18492 workaround: use fetchOne loop instead of async iterator
      const targetUids = uids.slice(-limit); // take most recent
      for (const uid of targetUids) {
        try {
          const msg = await client.fetchOne(String(uid), {
            uid: true,
            envelope: true,
            source: true,
          }, { uid: true });

          if (!msg) continue;

          const envelope = msg.envelope || {};
          const from = envelope.from?.[0];
          const fromAddr = from
            ? (from.address || `${from.mailbox}@${from.host}`)
            : "";
          const subject = envelope.subject || "(no subject)";
          const date = envelope.date ? new Date(envelope.date).toISOString() : "";

          // Filter by domain
          if (!matchesFilters(fromAddr, filters)) continue;

          // Parse body from raw source
          let textBody = "";
          let htmlBody = "";
          if (msg.source) {
            const raw = msg.source.toString("utf-8");
            const extracted = extractBodiesFromRaw(raw);
            textBody = extracted.text;
            htmlBody = extracted.html;
          }

          const msgUid = typeof uid === "number" ? uid : parseInt(String(uid), 10);
          if (msgUid > highestUid) highestUid = msgUid;

          emails.push({
            uid: msgUid,
            subject,
            from: fromAddr,
            fromDomain: domainFromAddress(fromAddr),
            date,
            textBody,
            htmlBody,
          });
        } catch {
          // Skip individual message errors
          continue;
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return { emails, highestUid };
}

// --- Raw MIME body extraction (handles multipart) ---

function extractBodiesFromRaw(raw: string): { text: string; html: string } {
  let text = "";
  let html = "";

  // Find boundary from Content-Type header
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) {
    // Single-part message — check content-type
    const headerEnd = raw.indexOf("\r\n\r\n");
    if (headerEnd === -1) return { text: raw, html: "" };
    const headers = raw.slice(0, headerEnd).toLowerCase();
    const body = raw.slice(headerEnd + 4);
    const encoding = headers.match(/content-transfer-encoding:\s*(\S+)/)?.[1];
    const decoded = decodeMimeBody(body, encoding);
    if (headers.includes("text/html")) {
      html = decoded;
    } else {
      text = decoded;
    }
    return { text, html };
  }

  const boundary = boundaryMatch[1];
  const parts = raw.split("--" + boundary);

  for (const part of parts) {
    if (part.startsWith("--")) continue; // closing boundary
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const partHeaders = part.slice(0, headerEnd).toLowerCase();
    const partBody = part.slice(headerEnd + 4);
    const encoding = partHeaders.match(/content-transfer-encoding:\s*(\S+)/)?.[1];

    // Recurse for nested multipart
    const nestedBoundary = partHeaders.match(/boundary="?([^"\r\n;]+)"?/i);
    if (nestedBoundary) {
      const nested = extractBodiesFromRaw(part.slice(headerEnd + 4));
      if (nested.text && !text) text = nested.text;
      if (nested.html && !html) html = nested.html;
      continue;
    }

    if (partHeaders.includes("text/plain") && !text) {
      text = decodeMimeBody(partBody.trimEnd(), encoding);
    } else if (partHeaders.includes("text/html") && !html) {
      html = decodeMimeBody(partBody.trimEnd(), encoding);
    }
  }

  return { text, html };
}
