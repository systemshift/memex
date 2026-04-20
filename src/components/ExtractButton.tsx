import { useEffect, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../api";
import { Sparkles, Loader2, CircleCheck, CircleAlert } from "../icons";

type Props = {
  nodeId: string;
  /** Called when extraction finishes successfully so the parent can
   *  refresh panels and show the new entities. */
  onDone?: () => void;
};

type State = "idle" | "running" | "done" | "error";

/**
 * Compact header button that triggers LLM entity extraction for the
 * current node. Shows progress ("person: Yann LeCun", "concept:
 * transformer") in a live status line while running, and the count
 * of entities linked when done.
 */
export function ExtractButton({ nodeId, onDone }: Props) {
  const [state, setState] = useState<State>("idle");
  const [status, setStatus] = useState<string>("");
  const [activeNode, setActiveNode] = useState<string>("");

  // Global listeners — we filter by activeNode in the payload of
  // extract-start so multiple instances of this button on different
  // nodes don't leak progress into each other.
  useEffect(() => {
    let unlistenStart: UnlistenFn | null = null;
    let unlistenItem: UnlistenFn | null = null;
    let unlistenDone: UnlistenFn | null = null;
    let unlistenError: UnlistenFn | null = null;

    (async () => {
      unlistenStart = await listen<string>("extract-start", (ev) => {
        setActiveNode(ev.payload);
      });
      unlistenItem = await listen<string>("extract-item", (ev) => {
        setStatus(ev.payload);
      });
      unlistenDone = await listen<string>("extract-done", (ev) => {
        setState("done");
        setStatus(ev.payload);
        if (onDone) onDone();
        // Ease the "done" pill back to idle so the button returns to
        // its default appearance after a successful run.
        window.setTimeout(() => {
          setState((s) => (s === "done" ? "idle" : s));
        }, 4000);
      });
      unlistenError = await listen<string>("extract-error", (ev) => {
        setState("error");
        setStatus(ev.payload);
      });
    })();

    return () => {
      unlistenStart?.();
      unlistenItem?.();
      unlistenDone?.();
      unlistenError?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reset transient state when switching nodes.
  useEffect(() => {
    setState("idle");
    setStatus("");
  }, [nodeId]);

  const isActiveHere = activeNode === nodeId;

  const onClick = async () => {
    setState("running");
    setStatus("starting…");
    try {
      await api.extractEntities(nodeId);
    } catch (e) {
      setState("error");
      setStatus(String(e));
    }
  };

  return (
    <div className="extract-wrap">
      <button
        className="btn-secondary extract-btn"
        onClick={onClick}
        disabled={state === "running"}
        title="Extract concepts, people, organizations, and claims from this node"
      >
        {state === "running" ? (
          <Loader2 size={13} className="spin" />
        ) : state === "done" ? (
          <CircleCheck size={13} />
        ) : state === "error" ? (
          <CircleAlert size={13} />
        ) : (
          <Sparkles size={13} />
        )}
        <span>
          {state === "running" ? "Extracting" : "Extract entities"}
        </span>
      </button>
      {(state === "running" || state === "done" || state === "error") && isActiveHere && status && (
        <span className={`extract-status ${state}`}>{status}</span>
      )}
    </div>
  );
}
