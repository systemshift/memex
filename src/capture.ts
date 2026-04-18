/**
 * Capture-first UX: open today's daily note in $EDITOR.
 *
 * Motivation: the ROAM bet — if writing friction is zero, humans accumulate
 * structure through use. A chat TUI is query-first, not capture-first, so
 * `memex capture` (or eventually the default no-args path) drops straight
 * into today's daily note with the editor the user already knows.
 */

import { spawnSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

function todayID(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `daily:${y}-${m}-${day}`;
}

function pickEditor(): string {
  return process.env.EDITOR || process.env.VISUAL || "vi";
}

/**
 * Ensure the daily note exists and open it in $EDITOR.
 *
 * Exits the process on fatal errors (missing mount, editor crash, etc.);
 * returns normally on clean editor exit so the caller can do its own cleanup.
 */
export async function captureDailyNote(opts: {
  mount: string;
}): Promise<void> {
  const mountPath = opts.mount ?? process.env.MEMEX_MOUNT ?? join(homedir(), ".memex", "mount");

  if (!existsSync(join(mountPath, "nodes"))) {
    console.error(`memex-fs is not mounted at ${mountPath}`);
    console.error("Start it with: memex-fs -data ~/.memex/data -mount " + mountPath);
    process.exit(1);
  }

  const id = todayID();
  const nodeDir = join(mountPath, "nodes", id);
  const contentPath = join(nodeDir, "content");

  // Creating the node dir goes through memex-fs Mkdir, which infers the type
  // from the id prefix ("daily" → "Daily") and sets up content/meta.json/etc.
  // If it already exists, mkdirSync with recursive:true is a no-op.
  if (!existsSync(nodeDir)) {
    try {
      mkdirSync(nodeDir, { recursive: true });
    } catch (e: any) {
      console.error(`Failed to create daily note ${id}: ${e.message}`);
      process.exit(1);
    }
  }

  // Ensure the content file exists before the editor opens — some editors
  // refuse to create new files through FUSE. A zero-byte file is fine.
  if (!existsSync(contentPath)) {
    try {
      writeFileSync(contentPath, "");
    } catch {
      // If the write fails (e.g. because the node was created with content
      // already), fall through and let the editor handle it.
    }
  }

  const editor = pickEditor();
  const result = spawnSync(editor, [contentPath], { stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to launch ${editor}: ${result.error.message}`);
    process.exit(1);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}
