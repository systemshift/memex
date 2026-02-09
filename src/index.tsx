/**
 * Entry point: parse args, start services, render Ink app.
 */

import React from "react";
import { render } from "ink";
import { join } from "path";
import { homedir } from "os";
import { App } from "./app";
import { ensureMemexServer, ensureIpfs } from "./binaries";
import {
  ensureIpfsRepo,
  isIpfsRunning,
  startIpfsDaemon,
  waitForIpfs,
  ensureDagitIdentity,
  startMemexServer,
  waitForServer,
  isGraphEmpty,
  cleanupAll,
  registerCleanup,
  log,
  warn,
  error,
} from "./services";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    serverOnly: false,
    port: parseInt(process.env.PORT ?? "8080", 10),
    backend: process.env.MEMEX_BACKEND ?? "sqlite",
    dbPath: process.env.SQLITE_PATH ?? join(homedir(), ".memex", "memex.db"),
    skipIpfs: false,
    skipDownload: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--server-only":
        opts.serverOnly = true;
        break;
      case "--port":
        opts.port = parseInt(args[++i], 10);
        break;
      case "--backend":
        opts.backend = args[++i];
        break;
      case "--db-path":
        opts.dbPath = args[++i];
        break;
      case "--skip-ipfs":
        opts.skipIpfs = true;
        break;
      case "--skip-download":
        opts.skipDownload = true;
        break;
      case "--help":
      case "-h":
        console.log(`Usage: memex [options]

Options:
  --server-only    Start server without TUI
  --port <n>       Server port (default: 8080)
  --backend <b>    Storage backend: sqlite or neo4j (default: sqlite)
  --db-path <p>    SQLite database path
  --skip-ipfs      Skip IPFS daemon setup
  --skip-download  Skip automatic binary downloads
  -h, --help       Show this help`);
        process.exit(0);
    }
  }

  return opts;
}

async function main() {
  const opts = parseArgs();

  registerCleanup();

  // Step 1: Check OPENAI_API_KEY
  if (!process.env.OPENAI_API_KEY) {
    error("OPENAI_API_KEY environment variable is not set.");
    error("Get your API key from: https://platform.openai.com/api-keys");
    error("Then run: export OPENAI_API_KEY=sk-...");
    process.exit(1);
  }

  // Step 2: Ensure memex-server binary
  let serverBin: string;
  if (opts.skipDownload) {
    const result = Bun.spawnSync(["which", "memex-server"], { stdout: "pipe" });
    const fromPath = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
    serverBin = process.env.MEMEX_SERVER ?? fromPath ?? "";
    if (!serverBin) {
      const cached = join(homedir(), ".memex", "bin", "memex-server");
      const { existsSync } = await import("fs");
      if (existsSync(cached)) {
        serverBin = cached;
      } else {
        error("memex-server not found (--skip-download active)");
        process.exit(1);
      }
    }
  } else {
    serverBin = await ensureMemexServer();
  }
  log(`memex-server: ${serverBin}`);

  // Step 3: Ensure IPFS binary
  let ipfsBin: string | null = null;
  if (!opts.skipIpfs) {
    if (opts.skipDownload) {
      const result = Bun.spawnSync(["which", "ipfs"], { stdout: "pipe" });
      ipfsBin = result.exitCode === 0 ? new TextDecoder().decode(result.stdout).trim() : null;
      if (!ipfsBin) {
        const cached = join(homedir(), ".memex", "bin", "ipfs");
        const { existsSync } = await import("fs");
        if (existsSync(cached)) {
          ipfsBin = cached;
        } else {
          warn("IPFS not found (--skip-download active), skipping IPFS");
        }
      }
    } else {
      ipfsBin = await ensureIpfs();
      log(`IPFS: ${ipfsBin}`);
    }
  }

  // Step 4: Ensure IPFS repo
  if (ipfsBin && !opts.skipIpfs) {
    await ensureIpfsRepo(ipfsBin);
  }

  // Step 5: Start IPFS daemon if needed
  if (ipfsBin && !opts.skipIpfs) {
    if (await isIpfsRunning()) {
      log("IPFS daemon already running");
    } else {
      await startIpfsDaemon(ipfsBin);
      if (await waitForIpfs()) {
        log("IPFS daemon ready");
      } else {
        warn("IPFS daemon did not start in time, continuing without it");
      }
    }
  }

  // Step 6: Ensure dagit identity
  const did = await ensureDagitIdentity();
  if (did !== "unknown") {
    log(`Identity: ${did}`);
  }

  // Step 7: Start memex-server
  await startMemexServer(serverBin, opts.port, opts.backend, opts.dbPath);

  // Step 8: Wait for server
  const serverUrl = `http://localhost:${opts.port}`;
  if (!(await waitForServer(serverUrl))) {
    error("Server failed to start");
    cleanupAll();
    process.exit(1);
  }
  log("Server ready");

  // Set MEMEX_URL for tools
  process.env.MEMEX_URL = serverUrl;

  if (opts.serverOnly) {
    log("Server running. Press Ctrl+C to stop.");
    // Keep process alive
    await new Promise(() => {});
    return;
  }

  // Step 9: Check if graph is empty
  const firstRun = await isGraphEmpty(serverUrl);
  if (firstRun) {
    log("Empty graph detected — starting onboarding");
  }

  // Step 10: Launch TUI
  log("Launching memex...");

  // Enter alternate screen buffer (like Textual / vim / Claude Code)
  process.stdout.write("\x1b[?1049h"); // enter alt screen
  process.stdout.write("\x1b[H");      // move cursor home

  const exitAltScreen = () => {
    process.stdout.write("\x1b[?1049l"); // exit alt screen
  };

  const { waitUntilExit } = render(<App firstRun={firstRun} />);
  await waitUntilExit();

  // Step 11: Cleanup
  exitAltScreen();
  cleanupAll();
}

main().catch((e) => {
  process.stdout.write("\x1b[?1049l"); // exit alt screen on crash
  console.error(e);
  cleanupAll();
  process.exit(1);
});
