/**
 * Color-coded message renderer.
 */

import React from "react";
import { Text, Box } from "ink";

interface MessageProps {
  role: "user" | "assistant" | "system" | "error" | "tool";
  content: string;
}

export function Message({ role, content }: MessageProps) {
  switch (role) {
    case "user":
      return (
        <Box>
          <Text bold color="cyan">You: </Text>
          <Text>{content}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box>
          <Text bold color="green">Memex: </Text>
          <Text>{content}</Text>
        </Box>
      );
    case "system":
      return (
        <Box>
          <Text dimColor italic>{content}</Text>
        </Box>
      );
    case "error":
      return (
        <Box>
          <Text bold color="red">Error: </Text>
          <Text>{content}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box>
          <Text dimColor>  {content}</Text>
        </Box>
      );
    default:
      return <Text>{content}</Text>;
  }
}
