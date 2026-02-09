/**
 * Subprocess management, health checks, and cleanup.
 */

import { existsSync, mkdirSync } from "fs";
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

export async function ensureDagitIdentity(): Promise<string> {
  const identityPath = join(homedir(), ".dagit", "identity.json");

  if (existsSync(identityPath)) {
    const data = JSON.parse(await Bun.file(identityPath).text());
    return data.did ?? "unknown";
  }

  // Create identity inline (same as dagit.identity.create)
  log("Creating dagit identity...");
  try {
    const { createIdentity } = await import("./identity");
    const identity = await createIdentity();
    log(`Identity created: ${identity.did}`);
    return identity.did;
  } catch (e: any) {
    warn(`Could not create dagit identity: ${e.message}`);
    return "unknown";
  }
}

export async function startMemexServer(
  serverBin: string,
  port: number,
  backend: string,
  dbPath: string,
): Promise<Subprocess> {
  const dir = dbPath.substring(0, dbPath.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });

  log(`Starting memex-server on port ${port} (${backend} backend)...`);

  const env = {
    ...process.env,
    PORT: String(port),
    MEMEX_BACKEND: backend,
    SQLITE_PATH: dbPath,
  };

  const proc = Bun.spawn([serverBin], {
    env,
    stdout: "ignore",
    stderr: "ignore",
  });
  procs.push(proc);
  return proc;
}

export async function waitForServer(url: string, timeout = 10000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${url}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (resp.status === 200) return true;
    } catch {}
    await Bun.sleep(200);
  }
  return false;
}

export async function isGraphEmpty(serverUrl: string): Promise<boolean> {
  try {
    const resp = await fetch(`${serverUrl}/api/nodes?limit=1`, {
      signal: AbortSignal.timeout(5000),
    });
    if (resp.status === 200) {
      const data = await resp.json() as any;
      const nodes = Array.isArray(data) ? data : (data.nodes ?? []);
      return nodes.length === 0;
    }
  } catch {}
  return true;
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
    cleanupAll();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanupAll();
    process.exit(0);
  });
}

export { log, warn, error };
