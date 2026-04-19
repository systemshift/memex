import { useEffect, useRef, useState } from "react";
import { api } from "../api";

type Props = {
  nodeId: string;
  /** Called after a successful save so the parent can refresh side panels. */
  onSaved?: () => void;
};

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Center column. Shows the current node's id + content. Editor is a raw
 * textarea for now — a block editor (BlockNote/Tiptap) is a later pass.
 *
 * Autosaves on a 800ms debounce while typing and immediately on blur.
 * Saves trigger onSaved so the right panel can re-fetch links/neighbors
 * once the graph sees the new content (and any [[refs]] inside it).
 */
export function Editor({ nodeId, onSaved }: Props) {
  const [content, setContent] = useState("");
  const [typeName, setTypeName] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const timer = useRef<number | null>(null);
  const loadedForId = useRef<string>("");

  // Load content whenever the selected node changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadError(null);
      try {
        const [text, type_] = await Promise.all([
          api.readNode(nodeId),
          api.readNodeType(nodeId),
        ]);
        if (cancelled) return;
        setContent(text);
        setTypeName(type_);
        loadedForId.current = nodeId;
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const commit = async (text: string) => {
    setSave("saving");
    try {
      await api.writeNode(nodeId, text);
      setSave("saved");
      onSaved?.();
    } catch (e) {
      setSave("error");
      setLoadError(String(e));
    }
  };

  const onChange = (text: string) => {
    setContent(text);
    setSave("idle");
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(text), 800);
  };

  const onBlur = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    // Only save if we've loaded into this node — prevents an immediate
    // blur from persisting "" over a node we haven't read yet.
    if (loadedForId.current === nodeId) commit(content);
  };

  return (
    <section className="editor-pane">
      <header className="editor-header">
        <div className="editor-title">
          <span className="node-id">{nodeId}</span>
          {typeName && <span className="node-type-pill">{typeName}</span>}
        </div>
        <div className={`save-indicator ${save}`}>
          {save === "saving" && "saving…"}
          {save === "saved" && "saved"}
          {save === "error" && "save failed"}
        </div>
      </header>

      {loadError && <p className="error" role="alert">{loadError}</p>}

      <textarea
        className="editor"
        value={content}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={onBlur}
        placeholder="Scribble here…"
        spellCheck
      />
    </section>
  );
}
