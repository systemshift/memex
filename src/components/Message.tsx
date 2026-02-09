/**
 * Color-coded message renderer.
 */

import React from "react";
import { Text, Box } from "ink";

interface MessageProps {
  role: "user" | "assistant" | "system" | "error" | "tool";
  content: string;
  width?: number;
}

export function Message({ role, content, width }: MessageProps) {
  switch (role) {
    case "user":
      return (
        <Box width={width} flexShrink={0}>
          <Text bold color="cyan">You: </Text>
          <Text wrap="wrap">{content}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box width={width} flexShrink={0}>
          <Text bold color="green">Memex: </Text>
          <Text wrap="wrap">{content}</Text>
        </Box>
      );
    case "system":
      return (
        <Box width={width} flexShrink={0}>
          <Text dimColor italic wrap="wrap">{content}</Text>
        </Box>
      );
    case "error":
      return (
        <Box width={width} flexShrink={0}>
          <Text bold color="red">Error: </Text>
          <Text wrap="wrap">{content}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box width={width} flexShrink={0}>
          <Text dimColor wrap="wrap">  {content}</Text>
        </Box>
      );
    default:
      return <Text wrap="wrap">{content}</Text>;
  }
}
