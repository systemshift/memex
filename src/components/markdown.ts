import chalk from "chalk";

// Force chalk color output — Ink manages the TTY so chalk's auto-detection
// may fail (especially in compiled binaries).
chalk.level = 3;

/**
 * Render inline markdown (bold, italic, code, bold+italic) to ANSI.
 * Handles nested patterns like ***bold italic***.
 */
function renderInline(text: string): string {
  return text
    // Inline code `text` (do first to avoid processing inside code)
    .replace(/`([^`]+)`/g, (_, content) => chalk.yellow(content))
    // Bold+italic ***text*** or ___text___
    .replace(/(\*{3}|_{3})(.+?)\1/g, (_, _m, content) => chalk.bold.italic(content))
    // Bold **text** or __text__
    .replace(/(\*{2}|_{2})(.+?)\1/g, (_, _m, content) => chalk.bold(content))
    // Italic *text* or _text_ (but not inside words for _)
    .replace(/(?<!\w|\*)\*([^*]+)\*(?!\*)/g, (_, content) => chalk.italic(content))
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, (_, content) => chalk.italic(content));
}

/**
 * Simple markdown-to-ANSI renderer for terminal display.
 * Handles: headers, bold, italic, inline code, code blocks, lists, blockquotes.
 */
export function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;
  let codeBlockLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code blocks
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        result.push(chalk.yellow(codeBlockLines.join("\n")));
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    // Headers
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      result.push(chalk.green.bold(renderInline(headingMatch[2])));
      continue;
    }

    // Blockquotes
    if (line.startsWith("> ")) {
      result.push(chalk.gray.italic(renderInline(line.slice(2))));
      continue;
    }

    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(line)) {
      result.push(chalk.dim("─".repeat(40)));
      continue;
    }

    // Unordered list items: strip bullet, render inline, re-add bullet
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.*)/);
    if (ulMatch) {
      result.push(`${ulMatch[1]}* ${renderInline(ulMatch[2])}`);
      continue;
    }

    // Ordered list items: strip number, render inline, re-add number
    const olMatch = line.match(/^(\s*)(\d+[.)]\s+)(.*)/);
    if (olMatch) {
      result.push(`${olMatch[1]}${olMatch[2]}${renderInline(olMatch[3])}`);
      continue;
    }

    // Everything else: render inline markdown
    result.push(renderInline(line));
  }

  // Close unclosed code block (streaming partial)
  if (inCodeBlock && codeBlockLines.length > 0) {
    result.push(chalk.yellow(codeBlockLines.join("\n")));
  }

  return result.join("\n");
}
