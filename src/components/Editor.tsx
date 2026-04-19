import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { typeIcon } from "../icons";

type Props = {
  nodeId: string;
  /** Called after a successful save so the parent can refresh side panels. */
  onSaved?: () => void;
  /** Reports content length to the status bar for word count. */
  onContentChange?: (content: string) => void;
};

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Center column. Shows the current node's label + type, and its
 * content as a textarea. Autosave: 800ms debounce on typing, immediate
 * on blur. A block editor (BlockNote/Tiptap) with [[ref]] autocomplete
 * replaces this in a later pass.
 */
export function Editor({ nodeId, onSaved, onContentChange }: Props) {
  const [content, setContent] = useState("");
  const [typeName, setTypeName] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const loadedForId = useRef<string>("");
  const [labelBump, setLabelBump] = useState(0);
  const labels = useNodeLabels([nodeId], labelBump);
  const label = labels[nodeId] ?? nodeId;
  const showIdSub = label !== nodeId;

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
        onContentChange?.(text);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const commit = async (text: string) => {
    try {
      await api.writeNode(nodeId, text);
      setLabelBump((b) => b + 1);
      onSaved?.();
    } catch (e) {
      setLoadError(String(e));
    }
  };

  const onChange = (text: string) => {
    setContent(text);
    onContentChange?.(text);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => commit(text), 800);
  };

  const onBlur = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (loadedForId.current === nodeId) commit(content);
  };

  const Icon = typeIcon(typeName);

  return (
    <section className="editor-pane">
      <header className="editor-header">
        <div className="editor-title">
          <Icon size={16} className="editor-type-icon" />
          <span className="editor-label" title={nodeId}>{label}</span>
          {typeName && <span className="node-type-pill">{typeName}</span>}
          {showIdSub && <span className="editor-id-sub">{nodeId}</span>}
        </div>
      </header>

      {loadError && <p className="error" role="alert">{loadError}</p>}

      <textarea
        className="editor"
        value={content}
        onChange={(e) => onChange(e.currentTarget.value)}
        onBlur={onBlur}
        placeholder="Scribble here. Use [[type:id]] to link to another node."
        spellCheck
      />
    </section>
  );
}

// Saving state is now surfaced by the global StatusBar; this re-export
// lets the parent wire the indicator. Editor still reports via onSaved.
export type EditorSaveState = SaveState;
