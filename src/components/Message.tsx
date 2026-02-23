/**
 * Color-coded message renderer.
 */

import React from "react";
import { Text, Box } from "ink";
import { renderMarkdown } from "./markdown";

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
          <Text wrap="wrap">{content}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box>
          <Text bold color="green">Memex: </Text>
          <Text wrap="wrap">{renderMarkdown(content)}</Text>
        </Box>
      );
    case "system":
      return (
        <Box>
          <Text dimColor italic wrap="wrap">{content}</Text>
        </Box>
      );
    case "error":
      return (
        <Box>
          <Text bold color="red">Error: </Text>
          <Text wrap="wrap">{content}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box>
          <Text dimColor wrap="wrap">  {content}</Text>
        </Box>
      );
    default:
      return <Text wrap="wrap">{content}</Text>;
  }
}
