/**
 * Ink root: layout, state, input handling.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, useInput, useApp } from "ink";
import { ChatLog, type ChatMessage } from "./components/ChatLog";
import { InputBar } from "./components/InputBar";
import { ChatEngine } from "./chat";

interface AppProps {
  firstRun: boolean;
}

let msgCounter = 0;

export function App({ firstRun }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState("");
  const engineRef = useRef<ChatEngine | null>(null);

  // Initialize engine
  if (!engineRef.current) {
    engineRef.current = new ChatEngine(firstRun);
  }
  const engine = engineRef.current;

  const addMessage = useCallback((role: ChatMessage["role"], content: string) => {
    setMessages((prev) => [...prev, { id: ++msgCounter, role, content }]);
  }, []);

  // Load memory or auto-greet on mount
  useEffect(() => {
    if (firstRun) {
      addMessage("system", "Welcome to Memex — setting things up...");
      setStreaming(true);
      setStatus("Setting up...");

      let buffer = "";
      let textStatusSet = false;

      engine
        .send(
          "I just installed memex. Help me get started.",
          (text) => {
            buffer += text;
            setStreamingText(buffer);
            if (!textStatusSet) {
              setStatus("Receiving response...");
              textStatusSet = true;
            }
          },
          (toolName) => {
            textStatusSet = false;
            const label = toolName.replace(/[\[\]]/g, "");
            setStatus(`Running ${label}...`);
          },
        )
        .then(() => {
          if (buffer) {
            addMessage("assistant", buffer);
          }
          setStreamingText("");
          setStatus("");
          setStreaming(false);
        })
        .catch((e: any) => {
          addMessage("error", e.message);
          setStreamingText("");
          setStatus("");
          setStreaming(false);
        });
    } else {
      addMessage("system", "Welcome to Memex. Ask questions about your knowledge graph or dagit network.");
      addMessage("system", 'Type "help" for commands, Ctrl+C to quit.');
      setStatus("Loading memory...");
      engine.loadMemory().then(() => setStatus("")).catch(() => setStatus(""));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || streaming) return;
      setInput("");

      // Special commands
      if (trimmed.toLowerCase() === "exit" || trimmed.toLowerCase() === "quit") {
        exit();
        return;
      }
      if (trimmed.toLowerCase() === "clear") {
        engine.clear();
        setMessages([]);
        addMessage("system", "Chat cleared.");
        return;
      }
      if (trimmed.toLowerCase() === "help") {
        addMessage("system", "Commands:");
        addMessage("system", '  help  - Show this help');
        addMessage("system", '  clear - Clear chat history');
        addMessage("system", '  exit  - Quit the application');
        addMessage("system", "");
        addMessage("system", "Examples:");
        addMessage("system", '  "search for notes about topic"');
        addMessage("system", '  "what\'s my dagit identity"');
        addMessage("system", '  "save this as a note: <your content>"');
        addMessage("system", '  "post to dagit: <your message>"');
        return;
      }

      addMessage("user", trimmed);
      setStreaming(true);
      setStatus("Thinking...");

      let buffer = "";
      let textStatusSet = false;

      engine
        .send(
          trimmed,
          (text) => {
            buffer += text;
            setStreamingText(buffer);
            if (!textStatusSet) {
              setStatus("Receiving response...");
              textStatusSet = true;
            }
          },
          (toolName) => {
            textStatusSet = false;
            const label = toolName.replace(/[\[\]]/g, "");
            if (label.startsWith("memex_")) {
              setStatus(`Searching knowledge graph (${label})...`);
            } else if (label.startsWith("dagit_")) {
              setStatus(`Querying dagit network (${label})...`);
            } else {
              setStatus(`Running ${label}...`);
            }
          },
        )
        .then(() => {
          if (buffer) {
            addMessage("assistant", buffer);
          }
          setStreamingText("");
          setStatus("");
          setStreaming(false);
        })
        .catch((e: any) => {
          addMessage("error", e.message);
          setStreamingText("");
          setStatus("");
          setStreaming(false);
        });
    },
    [streaming, engine, addMessage, exit],
  );

  // Handle Ctrl+C
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Box flexDirection="column" flexGrow={1}>
        <ChatLog messages={messages} streamingText={streamingText} status={status} />
      </Box>
      <InputBar value={input} onChange={setInput} onSubmit={handleSubmit} disabled={streaming} />
    </Box>
  );
}
