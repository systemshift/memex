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
}

/**
 * Estimate how many terminal rows a message will occupy.
 * Accounts for text wrapping at the given width.
 */
function estimateLines(msg: ChatMessage, innerWidth: number): number {
  const prefix = msg.role === "user" ? 5 : msg.role === "assistant" ? 7 : msg.role === "error" ? 7 : msg.role === "tool" ? 2 : 0;
  const totalLen = prefix + msg.content.length;
  const effectiveWidth = Math.max(innerWidth, 20);
  return Math.max(1, Math.ceil(totalLen / effectiveWidth));
}

export function ChatLog({ messages, streamingText, status, height, width }: ChatLogProps) {
  const innerWidth = width - 4; // account for border + padding

  // Figure out how many messages fit from the bottom
  let linesUsed = 0;
  if (status) linesUsed += 1;
  if (streamingText) {
    linesUsed += Math.max(1, Math.ceil((7 + streamingText.length) / Math.max(innerWidth, 20)));
  }

  const visible: ChatMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && linesUsed < height; i--) {
    const lines = estimateLines(messages[i], innerWidth);
    if (linesUsed + lines > height && visible.length > 0) break;
    linesUsed += lines;
    visible.unshift(messages[i]);
  }

  // Fill remaining space
  const emptyLines = Math.max(0, height - linesUsed);

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

      {/* Streaming response */}
      {streamingText ? (
        <Box width={innerWidth} flexShrink={0}>
          <Text bold color="green">Memex: </Text>
          <Text wrap="wrap">{streamingText}</Text>
        </Box>
      ) : null}

      {/* Status line */}
      {status ? (
        <Box width={innerWidth} flexShrink={0} justifyContent="center">
          <Text dimColor italic>{status}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
