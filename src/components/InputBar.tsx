/**
 * Text input with "> " prompt, fixed at bottom.
 */

import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  width: number;
}

export function InputBar({ value, onChange, onSubmit, disabled, width }: InputBarProps) {
  if (disabled) {
    return (
      <Box width={width} height={1}>
        <Text dimColor>{">"} </Text>
        <Text dimColor>...</Text>
      </Box>
    );
  }

  return (
    <Box width={width} height={1}>
      <Text color="cyan" bold>{">"} </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="Ask anything... (Ctrl+C to quit)"
      />
    </Box>
  );
}
