/**
 * Startup splash screen with gradient-colored ASCII art.
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[38;5;75m";

// Deep blue to bright blue gradient (256-color ANSI)
const grad = [
  "\x1b[38;5;17m",  // deep navy
  "\x1b[38;5;18m",  // dark blue
  "\x1b[38;5;19m",  // medium blue
  "\x1b[38;5;33m",  // royal blue
  "\x1b[38;5;39m",  // bright blue
  "\x1b[38;5;75m",  // sky blue
];

const logo = [
  "  ███╗   ███╗███████╗███╗   ███╗███████╗██╗  ██╗",
  "  ████╗ ████║██╔════╝████╗ ████║██╔════╝╚██╗██╔╝",
  "  ██╔████╔██║█████╗  ██╔████╔██║█████╗   ╚███╔╝ ",
  "  ██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║██╔══╝   ██╔██╗ ",
  "  ██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║███████╗██╔╝ ██╗",
  "  ╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝",
];

interface GraphStats {
  nodes: number;
  links: number;
  types: string[];
}

function readGraphStats(mount: string, data: string): GraphStats {
  let nodes = 0;
  let links = 0;
  let types: string[] = [];

  try {
    const nodesDir = join(mount, "nodes");
    if (existsSync(nodesDir)) {
      nodes = readdirSync(nodesDir).length;
    }
  } catch {}

  try {
    const linksFile = join(data, ".mx", "links.jsonl");
    if (existsSync(linksFile)) {
      const content = readFileSync(linksFile, "utf-8").trim();
      links = content ? content.split("\n").length : 0;
    }
  } catch {}

  try {
    const typesDir = join(mount, "types");
    if (existsSync(typesDir)) {
      types = readdirSync(typesDir);
    }
  } catch {}

  return { nodes, links, types };
}

export function printSplash(version: string, mount: string, data: string) {
  const stats = readGraphStats(mount, data);

  console.log();
  for (let i = 0; i < logo.length; i++) {
    console.log(grad[i] + logo[i] + RESET);
  }
  console.log();
  console.log(`  ${DIM}personal knowledge graph${RESET}                  ${DIM}v${version}${RESET}`);
  console.log(`  ${DIM}${"─".repeat(48)}${RESET}`);

  if (stats.nodes === 0) {
    console.log(`  ${DIM}empty graph — ready to explore${RESET}`);
  } else {
    const parts = [
      `${BLUE}${stats.nodes}${RESET}${DIM} nodes${RESET}`,
      `${BLUE}${stats.links}${RESET}${DIM} links${RESET}`,
      `${BLUE}${stats.types.length}${RESET}${DIM} types${RESET}`,
    ];
    console.log(`  ${parts.join(`${DIM} · ${RESET}`)}`);
    if (stats.types.length > 0) {
      console.log(`  ${DIM}${stats.types.join(", ")}${RESET}`);
    }
  }
  console.log();
}
