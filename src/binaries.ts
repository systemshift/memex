/**
 * Auto-download and cache external binaries in ~/.memex/bin/.
 */

import { existsSync, mkdirSync, chmodSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { $ } from "bun";

const BIN_DIR = join(homedir(), ".memex", "bin");

const MEMEX_SERVER_VERSION = "v0.1.0";
const KUBO_VERSION = "v0.32.1";

const MEMEX_SERVER_REPO = "systemshift/memex-server";
const KUBO_REPO = "ipfs/kubo";

function detectPlatform(): { os: string; arch: string } {
  const platform = process.platform;
  const machine = process.arch;

  let osName: string;
  if (platform === "linux") {
    osName = "linux";
  } else if (platform === "darwin") {
    osName = "darwin";
  } else {
    throw new Error(`Unsupported OS: ${platform}. Only Linux and macOS are supported.`);
  }

  let arch: string;
  if (machine === "x64") {
    arch = "amd64";
  } else if (machine === "arm64") {
    arch = "arm64";
  } else {
    throw new Error(`Unsupported architecture: ${machine}. Only x86_64 and arm64 are supported.`);
  }

  return { os: osName, arch };
}

async function downloadFile(url: string, dest: string, label: string): Promise<void> {
  const dir = dest.substring(0, dest.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });

  console.log(`  Downloading ${label}...`);
  console.log(`  ${url}`);

  const resp = await fetch(url, { redirect: "follow" });
  if (resp.status === 404) {
    throw new Error(`Download not found (404): ${url}\n  The release may not be published yet.`);
  }
  if (!resp.ok) {
    throw new Error(`Download failed (${resp.status}): ${url}`);
  }

  const buffer = await resp.arrayBuffer();
  await Bun.write(dest, buffer);

  const mb = (buffer.byteLength / (1024 * 1024)).toFixed(1);
  console.log(`  Downloaded ${label} (${mb} MB)`);
}

async function extractBinary(archive: string, binaryName: string, dest: string): Promise<void> {
  const dir = dest.substring(0, dest.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });

  // Extract with tar
  const tmpDir = join(dir, "_extract_tmp");
  mkdirSync(tmpDir, { recursive: true });

  const proc = Bun.spawn(["tar", "xzf", archive, "-C", tmpDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`tar extraction failed: ${stderr}`);
  }

  // Find the binary in extracted files
  const findProc = Bun.spawn(["find", tmpDir, "-name", binaryName.split("/").pop()!, "-type", "f"], {
    stdout: "pipe",
  });
  const findOutput = await new Response(findProc.stdout).text();
  await findProc.exited;

  const found = findOutput.trim().split("\n").filter(Boolean)[0];
  if (!found) {
    throw new Error(`Binary '${binaryName}' not found in archive`);
  }

  // Move to destination
  const mvProc = Bun.spawn(["mv", found, dest]);
  await mvProc.exited;

  // Make executable
  chmodSync(dest, 0o755);

  // Clean up
  Bun.spawn(["rm", "-rf", tmpDir]);
  unlinkSync(archive);
}

function whichSync(name: string): string | null {
  try {
    const result = Bun.spawnSync(["which", name], { stdout: "pipe" });
    if (result.exitCode === 0) {
      return new TextDecoder().decode(result.stdout).trim();
    }
  } catch {}
  return null;
}

export async function ensureMemexServer(): Promise<string> {
  // Check env var
  const envServer = process.env.MEMEX_SERVER;
  if (envServer && existsSync(envServer)) return envServer;

  // Check PATH
  const pathBin = whichSync("memex-server");
  if (pathBin) return pathBin;

  // Check cache
  const cached = join(BIN_DIR, "memex-server");
  if (existsSync(cached)) return cached;

  // Download
  console.log("\x1b[0;32m[memex]\x1b[0m memex-server not found, downloading...");
  try {
    const { os: osName, arch } = detectPlatform();
    const osLabel = osName === "linux" ? "Linux" : "Darwin";
    const archLabel = arch === "amd64" ? "x86_64" : "arm64";

    const filename = `memex-server_${osLabel}_${archLabel}.tar.gz`;
    const url = `https://github.com/${MEMEX_SERVER_REPO}/releases/download/${MEMEX_SERVER_VERSION}/${filename}`;

    const archivePath = join(BIN_DIR, filename);
    await downloadFile(url, archivePath, "memex-server");
    await extractBinary(archivePath, "memex-server", cached);

    console.log(`\x1b[0;32m[memex]\x1b[0m memex-server installed to ${cached}`);
    return cached;
  } catch (e: any) {
    console.error(`\x1b[0;31m[memex]\x1b[0m Failed to download memex-server: ${e.message}`);
    console.error(`\x1b[0;31m[memex]\x1b[0m Install manually from: https://github.com/${MEMEX_SERVER_REPO}/releases`);
    process.exit(1);
  }
}

export async function ensureIpfs(): Promise<string> {
  // Check PATH
  const pathBin = whichSync("ipfs");
  if (pathBin) return pathBin;

  // Check cache
  const cached = join(BIN_DIR, "ipfs");
  if (existsSync(cached)) return cached;

  // Download
  console.log("\x1b[0;32m[memex]\x1b[0m IPFS not found, downloading kubo...");
  try {
    const { os: osName, arch } = detectPlatform();
    const filename = `kubo_${KUBO_VERSION}_${osName}-${arch}.tar.gz`;
    const url = `https://github.com/${KUBO_REPO}/releases/download/${KUBO_VERSION}/${filename}`;

    const archivePath = join(BIN_DIR, filename);
    await downloadFile(url, archivePath, "IPFS (kubo)");
    await extractBinary(archivePath, "kubo/ipfs", cached);

    console.log(`\x1b[0;32m[memex]\x1b[0m IPFS installed to ${cached}`);
    return cached;
  } catch (e: any) {
    console.error(`\x1b[0;31m[memex]\x1b[0m Failed to download IPFS: ${e.message}`);
    console.error(`\x1b[0;31m[memex]\x1b[0m Install manually from: https://docs.ipfs.tech/install/`);
    process.exit(1);
  }
}
