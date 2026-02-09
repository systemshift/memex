/**
 * Text input with "> " prompt.
 */

import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function InputBar({ value, onChange, onSubmit, disabled }: InputBarProps) {
  if (disabled) {
    return (
      <Box>
        <Text dimColor>{">"} </Text>
        <Text dimColor>...</Text>
      </Box>
    );
  }

  return (
    <Box>
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
