/**
 * Scrollable messages display using Ink <Static>.
 */

import React from "react";
import { Static, Box, Text } from "ink";
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
}

export function ChatLog({ messages, streamingText, status }: ChatLogProps) {
  return (
    <Box flexDirection="column">
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id}>
            <Message role={msg.role} content={msg.content} />
          </Box>
        )}
      </Static>

      {streamingText ? (
        <Box>
          <Text bold color="green">Memex: </Text>
          <Text>{streamingText}</Text>
        </Box>
      ) : null}

      {status ? (
        <Box>
          <Text dimColor italic>{status}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
