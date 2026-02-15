/**
 * Terminal mouse tracking: enables scroll wheel detection via SGR mode.
 * Creates a filtered stdin Transform that strips mouse sequences before
 * Ink processes them, preventing garbled text in the input bar.
 */

import { PassThrough } from "stream";

export type ScrollDirection = "up" | "down";

const MOUSE_RE = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
const MOUSE_TEST = /\x1b\[<\d+;\d+;\d+[Mm]/;

let scrollCallback: ((dir: ScrollDirection) => void) | null = null;

export function onScroll(cb: (dir: ScrollDirection) => void) {
  scrollCallback = cb;
}

export function offScroll() {
  scrollCallback = null;
}

/**
 * Create a PassThrough stream that sits between process.stdin and Ink.
 * Mouse escape sequences are parsed and emitted via the callback,
 * everything else is forwarded to Ink unchanged.
 */
export function createFilteredStdin(): PassThrough {
  const filtered = new PassThrough();

  // Proxy TTY properties so Ink treats it like a real terminal
  (filtered as any).isTTY = process.stdin.isTTY;
  (filtered as any).isRaw = false;
  (filtered as any).setRawMode = function (mode: boolean) {
    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(mode);
    }
    (filtered as any).isRaw = mode;
    return filtered;
  };
  (filtered as any).ref = () => { process.stdin.ref?.(); return filtered; };
  (filtered as any).unref = () => { process.stdin.unref?.(); return filtered; };

  // Forward stdin data through the filter
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    const str = data.toString();
    if (MOUSE_TEST.test(str)) {
      for (const m of str.matchAll(MOUSE_RE)) {
        const btn = parseInt(m[1]);
        if (btn === 64) scrollCallback?.("up");
        if (btn === 65) scrollCallback?.("down");
      }
      const rest = str.replace(MOUSE_RE, "");
      if (rest) filtered.push(Buffer.from(rest));
      return;
    }
    filtered.push(data);
  });
  process.stdin.on("end", () => filtered.push(null));

  return filtered;
}

export function enableMouseTracking() {
  process.stdout.write("\x1b[?1000h"); // button events
  process.stdout.write("\x1b[?1006h"); // SGR extended coordinates
}

export function disableMouseTracking() {
  process.stdout.write("\x1b[?1006l");
  process.stdout.write("\x1b[?1000l");
}
