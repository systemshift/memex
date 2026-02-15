/**
 * Ink root: fullscreen layout, state, input handling.
 * Uses alternate screen buffer for a proper TUI experience.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Box, useInput, useApp, Text } from "ink";
import { ChatLog, type ChatMessage } from "./components/ChatLog";
import { InputBar } from "./components/InputBar";
import { ChatEngine } from "./chat";
import { onScroll, offScroll } from "./mouse";

interface AppProps {
  firstRun: boolean;
}

let msgCounter = 0;

function useTerminalSize() {
  const [size, setSize] = useState({
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  });

  useEffect(() => {
    const onResize = () => {
      setSize({
        rows: process.stdout.rows || 24,
        cols: process.stdout.columns || 80,
      });
    };
    process.stdout.on("resize", onResize);
    return () => { process.stdout.off("resize", onResize); };
  }, []);

  return size;
}

export function App({ firstRun }: AppProps) {
  const { exit } = useApp();
  const { rows, cols } = useTerminalSize();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [status, setStatus] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const engineRef = useRef<ChatEngine | null>(null);

  if (!engineRef.current) {
    engineRef.current = new ChatEngine(firstRun);
  }
  const engine = engineRef.current;

  const addMessage = useCallback((role: ChatMessage["role"], content: string) => {
    setMessages((prev) => [...prev, { id: ++msgCounter, role, content }]);
    setScrollOffset(0); // snap to bottom on new message
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
          if (buffer) addMessage("assistant", buffer);
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
      addMessage("system", "Welcome to Memex. Type \"help\" for commands, Ctrl+C to quit.");
      setStatus("Loading memory...");
      engine.loadMemory().then(() => setStatus("")).catch(() => setStatus(""));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || streaming) return;
      setInput("");

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
        addMessage("system", "Commands: help, clear, exit");
        addMessage("system", "Just type naturally — memex searches your graph and uses tools automatically.");
        return;
      }

      addMessage("user", trimmed);
      setScrollOffset(0);
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
            } else if (label === "dagit_follow") {
              setStatus("Following DID...");
            } else if (label === "dagit_unfollow") {
              setStatus("Unfollowing DID...");
            } else if (label === "dagit_following") {
              setStatus("Listing followed feeds...");
            } else if (label === "dagit_check_feeds") {
              setStatus("Checking followed feeds...");
            } else if (label.startsWith("dagit_")) {
              setStatus(`Querying dagit network (${label})...`);
            } else if (label === "email_check_now") {
              setStatus(`Checking email...`);
            } else if (label === "email_configure") {
              setStatus(`Configuring email...`);
            } else if (label === "email_status") {
              setStatus(`Checking email status...`);
            } else {
              setStatus(`Running ${label}...`);
            }
          },
        )
        .then(() => {
          if (buffer) addMessage("assistant", buffer);
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

  // Mouse wheel scroll via filtered stdin (see mouse.ts)
  const messagesLenRef = useRef(messages.length);
  messagesLenRef.current = messages.length;

  useEffect(() => {
    onScroll((dir) => {
      if (dir === "up") {
        setScrollOffset((prev) => Math.min(prev + 1, messagesLenRef.current - 1));
      } else {
        setScrollOffset((prev) => Math.max(prev - 1, 0));
      }
    });
    return () => offScroll();
  }, []);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
    // Shift+Up/Down: keyboard scroll fallback
    if (key.shift && key.upArrow) {
      setScrollOffset((prev) => Math.min(prev + 3, messages.length - 1));
    }
    if (key.shift && key.downArrow) {
      setScrollOffset((prev) => Math.max(prev - 3, 0));
    }
  });

  // Layout: chat panel takes all space minus 1 row for input
  const chatHeight = rows - 1;

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <ChatLog
        messages={messages}
        streamingText={streamingText}
        status={status}
        height={chatHeight}
        width={cols}
        scrollOffset={scrollOffset}
      />
      <InputBar
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={streaming}
        width={cols}
      />
    </Box>
  );
}
