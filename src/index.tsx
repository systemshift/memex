/**
 * Entry point: parse args, start services, render Ink app.
 */

import React from "react";
import { render } from "ink";
import { join } from "path";
import { homedir } from "os";
import { App } from "./app";
import { ensureIpfs } from "./binaries";
import * as emailModule from "./email";
import { ingestNewEmails } from "./email-ingest";
import {
  ensureIpfsRepo,
  isIpfsRunning,
  startIpfsDaemon,
  waitForIpfs,
  ensureDagitIdentity,
  isMounted,
  isGraphEmpty,
  cleanupAll,
  registerCleanup,
  log,
  warn,
  error,
} from "./services";
import { printSplash } from "./splash";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mount: process.env.MEMEX_MOUNT ?? join(homedir(), ".memex", "mount"),
    data: process.env.MEMEX_DATA ?? join(homedir(), ".memex", "data"),
    skipIpfs: false,
    skipDownload: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--mount":
        opts.mount = args[++i];
        break;
      case "--data":
        opts.data = args[++i];
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
  --mount <path>   FUSE mountpoint (default: ~/.memex/mount)
  --data <path>    Data directory (default: ~/.memex/data)
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

  // Step 2: Check FUSE mountpoint
  if (!isMounted(opts.mount)) {
    error(`memex-fs is not mounted at ${opts.mount}`);
    error("Start it with: memex-fs -data " + opts.data + " -mount " + opts.mount);
    process.exit(1);
  }
  printSplash("0.2.0", opts.mount, opts.data);

  // Set env vars for tools
  process.env.MEMEX_MOUNT = opts.mount;
  process.env.MEMEX_DATA = opts.data;

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

  // Import dagit key into Kubo keystore (fire-and-forget)
  if (ipfsBin && !opts.skipIpfs) {
    const keyProc = Bun.spawn(["python3", "-c", "from dagit.feed import ensure_dagit_key; ensure_dagit_key()"], {
      stdout: "ignore", stderr: "pipe",
    });
    keyProc.exited.then((code) => {
      if (code === 0) log("Dagit key imported into Kubo");
    }).catch(() => {});
  }

  // Auto-check email on startup (fire-and-forget, non-blocking)
  if (emailModule.isConfigured()) {
    log("Checking email...");
    ingestNewEmails().then((result) => {
      if (result.emailsFound > 0) {
        log(`Email: ${result.emailsFound} new, ${result.extractionsCreated} extractions`);
      } else {
        log("Email: no new messages");
      }
    }).catch((e: any) => {
      warn(`Email check failed: ${e.message}`);
    });
  }

  // Auto-check followed feeds on startup (fire-and-forget)
  if (ipfsBin && !opts.skipIpfs) {
    const { existsSync } = await import("fs");
    const followingFile = join(homedir(), ".dagit", "following.json");
    if (existsSync(followingFile)) {
      log("Checking followed feeds...");
      const feedProc = Bun.spawn(["dagit", "check-feeds"], { stdout: "pipe", stderr: "ignore" });
      feedProc.exited.then(async (code) => {
        if (code === 0) {
          const out = await new Response(feedProc.stdout).text();
          log(`Feeds: ${out.trim()}`);
        }
      }).catch(() => {});
    }
  }

  // Step 7: Check if graph is empty
  const firstRun = isGraphEmpty(opts.mount);
  if (firstRun) {
    log("Empty graph detected — starting onboarding");
  }

  // Step 8: Launch TUI

  // Fix terminal scrollback for VTE-based terminals (Terminator, etc.).
  // Two problems with stock Ink:
  // 1. clearTerminal emits \x1b[3J which nukes the scrollback buffer — strip it.
  // 2. Ink's rapid cursor-up/erase-line cycle makes VTE suppress user scrollback.
  //    Wrapping each write in DEC 2026 synchronized update sequences tells VTE to
  //    apply the frame atomically, preserving normal scroll behavior.
  const origWrite = process.stdout.write.bind(process.stdout);
  const SYNC_START = "\x1b[?2026h";
  const SYNC_END = "\x1b[?2026l";
  (process.stdout as any).write = (chunk: any, ...args: any[]) => {
    if (typeof chunk === "string") {
      chunk = SYNC_START + chunk.replace(/\x1b\[3J/g, "") + SYNC_END;
    }
    return origWrite(chunk, ...args);
  };

  const { waitUntilExit } = render(<App firstRun={firstRun} />);
  await waitUntilExit();

  // Step 9: Cleanup
  cleanupAll();
}

main().catch((e) => {
  console.error(e);
  cleanupAll();
  process.exit(1);
});
