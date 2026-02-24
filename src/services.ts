/**
 * Subprocess management, health checks, and cleanup.
 */

import { existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { Subprocess } from "bun";

const procs: Subprocess[] = [];
let cleaningUp = false;

function log(msg: string) {
  console.log(`\x1b[0;32m[memex]\x1b[0m ${msg}`);
}

function warn(msg: string) {
  console.log(`\x1b[1;33m[memex]\x1b[0m ${msg}`);
}

function error(msg: string) {
  console.error(`\x1b[0;31m[memex]\x1b[0m ${msg}`);
}

export async function isIpfsRunning(): Promise<boolean> {
  try {
    const resp = await fetch("http://localhost:5001/api/v0/id", {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    return resp.status === 200;
  } catch {
    return false;
  }
}

export async function ensureIpfsRepo(ipfsBin: string): Promise<void> {
  if (existsSync(join(homedir(), ".ipfs"))) return;

  log("Initializing IPFS repository...");
  const proc = Bun.spawn([ipfsBin, "init"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    error(`IPFS init failed: ${stderr}`);
    process.exit(1);
  }
  log("IPFS repository initialized");
}

export async function startIpfsDaemon(ipfsBin: string): Promise<Subprocess> {
  log("Starting IPFS daemon...");
  const proc = Bun.spawn([ipfsBin, "daemon"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(proc);
  return proc;
}

export async function waitForIpfs(timeout = 30000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isIpfsRunning()) return true;
    await Bun.sleep(500);
  }
  return false;
}

export async function ensureIdentity(): Promise<string> {
  const { loadIdentity, createIdentity } = await import("./identity");

  const existing = await loadIdentity();
  if (existing) return existing.did ?? "unknown";

  log("Creating identity...");
  try {
    const identity = await createIdentity();
    log(`Identity created: ${identity.did}`);
    return identity.did;
  } catch (e: any) {
    warn(`Could not create identity: ${e.message}`);
    return "unknown";
  }
}

export function isMounted(mountPath: string): boolean {
  try {
    const entries = readdirSync(mountPath);
    // A live memex-fs mount has nodes/, types/, search/ at minimum
    return entries.includes("nodes") && entries.includes("types") && entries.includes("search");
  } catch {
    return false;
  }
}

export function isGraphEmpty(mountPath: string): boolean {
  try {
    const entries = readdirSync(join(mountPath, "nodes"));
    return entries.length === 0;
  } catch {
    return true;
  }
}

export function cleanupAll(): void {
  if (cleaningUp) return;
  cleaningUp = true;

  for (const proc of procs.reverse()) {
    try {
      proc.kill("SIGTERM");
      // Give 5s then force kill
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 5000);
    } catch {}
  }
}

export function registerCleanup(): void {
  process.on("SIGINT", () => {
    process.stdout.write("\x1b[?1049l"); // exit alt screen
    cleanupAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    process.stdout.write("\x1b[?1049l"); // exit alt screen
    cleanupAll();
    process.exit(0);
  });
}

export { log, warn, error };
