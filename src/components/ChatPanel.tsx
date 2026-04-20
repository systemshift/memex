import { useEffect, useRef, useState, FormEvent } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, ChatMessage } from "../api";
import { MessageSquare, Sparkles } from "../icons";

type Props = {
  nodeId: string;
};

/**
 * "Ask this document." Each question sent includes a compiled context
 * block about the current node (content + backlinks + outgoing + top
 * neighbors) so the LLM answers from the user's graph.
 *
 * Streaming chunks append directly to the last assistant bubble via
 * functional setHistory — no shared mutable accumulator. This is what
 * fixes the "bubble disappears mid-stream" bug: the previous impl
 * used a ref that a chat-done handler would reset to "", and if a
 * duplicate listener (e.g. under React StrictMode's double-mount
 * dance) replayed the reset, subsequent chunks would overwrite the
 * bubble with only the latest payload.
 */
export function ChatPanel({ nodeId }: Props) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextText, setContextText] = useState<string | null>(null);
  const [showContext, setShowContext] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setHistory([]);
    setInput("");
    setError(null);
    setContextText(null);
    setShowContext(false);
  }, [nodeId]);

  useEffect(() => {
    // The listen() call is async; if the component unmounts (or
    // StrictMode tears down) before it resolves, we have to
    // remember to unlisten the moment it does resolve. Otherwise
    // we end up with zombie listeners multiplying setHistory
    // updates — which was the original blink bug.
    let cancelled = false;
    let unlistenChunk: UnlistenFn | null = null;
    let unlistenDone: UnlistenFn | null = null;
    let unlistenError: UnlistenFn | null = null;

    const register = async () => {
      const c = await listen<string>("chat-chunk", (ev) => {
        const delta = ev.payload;
        setHistory((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last && last.role === "assistant") {
            next[next.length - 1] = {
              ...last,
              content: last.content + delta,
            };
          } else {
            next.push({ role: "assistant", content: delta });
          }
          return next;
        });
      });
      if (cancelled) {
        c();
        return;
      }
      unlistenChunk = c;

      const d = await listen<null>("chat-done", () => {
        setStreaming(false);
      });
      if (cancelled) {
        d();
        return;
      }
      unlistenDone = d;

      const e = await listen<string>("chat-error", (ev) => {
        setStreaming(false);
        setError(ev.payload);
      });
      if (cancelled) {
        e();
        return;
      }
      unlistenError = e;
    };
    register();

    return () => {
      cancelled = true;
      unlistenChunk?.();
      unlistenDone?.();
      unlistenError?.();
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [history]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || streaming) return;
    setError(null);
    setInput("");
    setHistory((prev) => [...prev, { role: "user", content: question }]);
    setStreaming(true);
    try {
      await api.askStream(nodeId, history, question);
    } catch (e) {
      setStreaming(false);
      setError(String(e));
    }
  };

  const onClear = () => {
    if (streaming) return;
    setHistory([]);
    setError(null);
  };

  const toggleContext = async () => {
    if (!showContext && contextText === null) {
      try {
        const ctx = await api.compileNodeContext(nodeId);
        setContextText(ctx);
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    setShowContext((v) => !v);
  };

  return (
    <section className="chat-panel">
      <div className="chat-transcript" ref={scrollRef}>
        {history.length === 0 && !streaming && (
          <div className="chat-empty">
            <Sparkles size={18} />
            <h4>Ask anything about this node</h4>
            <p className="muted">
              The assistant sees this node's content, backlinks, outgoing
              links, and top neighbors — your graph, not the open web.
              Good prompts for a blank page:
            </p>
            <ul>
              <li>"Summarise what I've said about this so far."</li>
              <li>"What's missing or contradictory in my notes on this?"</li>
              <li>"Which of my nodes are most related and why?"</li>
            </ul>
          </div>
        )}
        {history.map((m, i) => {
          // The actively-streaming bubble renders as plain text so
          // partial-markdown reparsing doesn't visually flicker. Once
          // chat-done fires, streaming flips off and the same bubble
          // re-renders via react-markdown.
          const isStreamingBubble =
            streaming &&
            i === history.length - 1 &&
            m.role === "assistant";
          return (
            <Bubble
              key={i}
              role={m.role}
              content={m.content}
              asMarkdown={m.role === "assistant" && !isStreamingBubble}
            />
          );
        })}
        {streaming && history[history.length - 1]?.role !== "assistant" && (
          <div className="chat-bubble assistant">
            <div className="chat-bubble-role">assistant</div>
            <div className="chat-bubble-content muted">
              <MessageSquare size={12} /> thinking…
            </div>
          </div>
        )}
        {error && <p className="error chat-error">{error}</p>}
      </div>

      <div className="chat-context-toggle">
        <button className="link-button" onClick={toggleContext}>
          {showContext ? "Hide" : "Show"} compiled context
        </button>
        {history.length > 0 && (
          <button
            className="link-button subtle"
            onClick={onClear}
            disabled={streaming}
          >
            Clear
          </button>
        )}
      </div>
      {showContext && contextText !== null && (
        <pre className="chat-context">{contextText}</pre>
      )}

      <form className="chat-input-row" onSubmit={onSubmit}>
        <textarea
          className="chat-input"
          value={input}
          placeholder="Ask about this node…"
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit(e as unknown as FormEvent);
            }
          }}
          rows={2}
          disabled={streaming}
        />
        <button
          className="btn-primary"
          type="submit"
          disabled={streaming || !input.trim()}
        >
          {streaming ? "…" : "Send"}
        </button>
      </form>
    </section>
  );
}

function Bubble({
  role,
  content,
  asMarkdown,
}: {
  role: string;
  content: string;
  /** When true, run content through react-markdown. When false, show
   *  plain text with `pre-wrap` formatting. Streaming bubbles use
   *  plain text so partial-syntax reparsing doesn't flicker. */
  asMarkdown: boolean;
}) {
  return (
    <div className={`chat-bubble ${role} ${asMarkdown ? "md" : "plain"}`}>
      <div className="chat-bubble-role">{role}</div>
      <div className="chat-bubble-content">
        {asMarkdown ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {content || "…"}
          </ReactMarkdown>
        ) : (
          content || "…"
        )}
      </div>
    </div>
  );
}
