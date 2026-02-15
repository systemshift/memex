/**
 * Scrollable chat viewport — shows last N messages that fit in the panel.
 */

import React from "react";
import { Box, Text } from "ink";
import { Message } from "./Message";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system" | "error" | "tool";
  content: string;
}

interface ChatLogProps {
  messages: ChatMessage[];
  streamingText: string;
  status: string;
  height: number;
  width: number;
  scrollOffset: number;
}

/**
 * Estimate how many terminal rows a message will occupy.
 * Accounts for newlines in content and text wrapping at the given width.
 */
function estimateLines(msg: ChatMessage, innerWidth: number): number {
  const prefixLen = msg.role === "user" ? 5 : msg.role === "assistant" ? 7 : msg.role === "error" ? 7 : msg.role === "tool" ? 2 : 0;
  const effectiveWidth = Math.max(innerWidth, 20);
  const lines = msg.content.split("\n");
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = (i === 0 ? prefixLen : 0) + lines[i].length;
    total += Math.max(1, Math.ceil(len / effectiveWidth));
  }
  return total;
}

function estimateStreamingLines(text: string, innerWidth: number): number {
  const effectiveWidth = Math.max(innerWidth, 20);
  const lines = text.split("\n");
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = (i === 0 ? 7 : 0) + lines[i].length; // "Memex: " prefix on first line
    total += Math.max(1, Math.ceil(len / effectiveWidth));
  }
  return total;
}

export function ChatLog({ messages, streamingText, status, height, width, scrollOffset }: ChatLogProps) {
  const innerWidth = width - 4; // account for border + padding
  const innerHeight = height - 2; // account for top + bottom border
  const scrolled = scrollOffset > 0;

  // Reserve space for scroll indicator, status, and streaming text
  let linesUsed = 0;
  if (scrolled) linesUsed += 1; // "↓ more below" indicator
  if (!scrolled && status) linesUsed += 1;
  if (!scrolled && streamingText) {
    linesUsed += estimateStreamingLines(streamingText, innerWidth);
  }

  // Skip `scrollOffset` messages from the end, then fill viewport backward
  const endIndex = messages.length - 1 - scrollOffset;
  const visible: ChatMessage[] = [];
  for (let i = Math.min(endIndex, messages.length - 1); i >= 0 && linesUsed < innerHeight; i--) {
    const lines = estimateLines(messages[i], innerWidth);
    if (linesUsed + lines > innerHeight && visible.length > 0) break;
    linesUsed += lines;
    visible.unshift(messages[i]);
  }

  // Fill remaining space
  const emptyLines = Math.max(0, innerHeight - linesUsed);

  return (
    <Box
      flexDirection="column"
      height={height}
      width={width}
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      overflow="hidden"
    >
      {/* Spacer to push content to bottom */}
      {emptyLines > 0 && <Box height={emptyLines} />}

      {/* Messages */}
      {visible.map((msg) => (
        <Message key={msg.id} role={msg.role} content={msg.content} width={innerWidth} />
      ))}

      {/* Streaming response (only when not scrolled up) */}
      {!scrolled && streamingText ? (
        <Box width={innerWidth} flexShrink={0}>
          <Text bold color="green">Memex: </Text>
          <Text wrap="wrap">{streamingText}</Text>
        </Box>
      ) : null}

      {/* Status line (only when not scrolled up) */}
      {!scrolled && status ? (
        <Box width={innerWidth} flexShrink={0} justifyContent="center">
          <Text dimColor italic>{status}</Text>
        </Box>
      ) : null}

      {/* Scroll indicator */}
      {scrolled ? (
        <Box width={innerWidth} flexShrink={0} justifyContent="center">
          <Text dimColor>↓ Shift+Down to scroll back · Shift+Up for more</Text>
        </Box>
      ) : null}
    </Box>
  );
}
