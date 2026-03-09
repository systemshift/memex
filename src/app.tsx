/**
 * Ink root: uses <Static> for completed messages (native scrollback)
 * and a dynamic area for streaming response + status + input.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { Box, Static, useInput, useApp, Text } from "ink";
import { Message } from "./components/Message";
import { InputBar } from "./components/InputBar";
import { ChatEngine } from "./chat";
import { renderMarkdown } from "./components/markdown";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "system" | "error" | "tool";
  content: string;
}

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
  const [engine] = useState(() => new ChatEngine(firstRun));

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
      engine.loadMemory().then(() => {
        setStreaming(true);
        setStatus("Checking what's new...");

        let buffer = "";
        let textStatusSet = false;

        engine
          .send(
            "Check for new content — run email_check_now if email is configured, and dagit_check_feeds if there are followed feeds. If there's anything new, surface it with connections to existing knowledge. If nothing new, just greet me briefly.",
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
      }).catch(() => setStatus(""));
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
            } else if (label === "graph_explore") {
              setStatus("Exploring knowledge graph...");
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

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  // Truncate streaming text so the dynamic area never overflows the viewport.
  // When it overflows, Ink fires clearTerminal (\x1b[3J) which nukes scrollback.
  const rows = process.stdout.rows || 24;
  const cols = process.stdout.columns || 80;
  const maxStreamLines = Math.max(4, rows - 4); // reserve: status + input + margin

  const visibleStreamingText = useMemo(() => {
    if (!streamingText) return "";
    // Account for line wrapping at terminal width
    const lines = streamingText.split("\n");
    let wrappedCount = 0;
    const kept: string[] = [];
    // Walk backwards to keep the most recent content
    for (let i = lines.length - 1; i >= 0 && wrappedCount < maxStreamLines; i--) {
      const lineLen = (i === 0 ? 7 : 0) + lines[i].length; // "Memex: " prefix on first line
      const wrapped = Math.max(1, Math.ceil(lineLen / cols));
      wrappedCount += wrapped;
      kept.unshift(lines[i]);
    }
    if (kept.length < lines.length) {
      kept[0] = "..." + kept[0];
    }
    return kept.join("\n");
  }, [streamingText, maxStreamLines, cols]);

  return (
    <>
      <Static items={messages}>
        {(msg) => <Message key={msg.id} role={msg.role} content={msg.content} />}
      </Static>

      {visibleStreamingText ? (
        <Box>
          <Text bold color="green">Memex: </Text>
          <Text wrap="wrap">{renderMarkdown(visibleStreamingText)}</Text>
        </Box>
      ) : null}

      {status ? <Text color="#E87B35" italic>{status}</Text> : null}

      <InputBar value={input} onChange={setInput} onSubmit={handleSubmit} disabled={streaming} />
    </>
  );
}
