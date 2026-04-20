import { useEffect, useState } from "react";
import { api } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { typeIcon } from "../icons";
import { RichEditor } from "./RichEditor";

type Props = {
  nodeId: string;
  /** Fires after every successful save. Cheap — just the status-bar
   *  indicator path. */
  onSaved?: () => void;
  /** Fires only when the save introduced or removed `[[refs]]`, i.e.
   *  when backlinks / neighbors elsewhere in the app may have moved.
   *  The expensive app-wide refetch hangs off this, not onSaved. */
  onGraphChanged?: () => void;
  /** Reports content length to the status bar for word count. */
  onContentChange?: (content: string) => void;
  /** No longer forwarded to the editor — its autocomplete uses a
   *  TTL-based lazy refresh instead. Kept in the type for callers
   *  that pass it. */
  refreshKey?: number;
};

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Center column. Shows the current node's label + type, and its
 * content rendered by the BlockNote-backed RichEditor. Storage stays
 * markdown so Claude Code and bash stay first-class consumers.
 */
export function Editor({ nodeId, onSaved, onGraphChanged, onContentChange }: Props) {
  const [typeName, setTypeName] = useState<string>("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [labelBump, setLabelBump] = useState(0);
  const labels = useNodeLabels([nodeId], labelBump);
  const label = labels[nodeId] ?? nodeId;
  const showIdSub = label !== nodeId;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadError(null);
      try {
        const t = await api.readNodeType(nodeId);
        if (cancelled) return;
        setTypeName(t);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const handleSaved = () => {
    // Re-derive this node's label after a save in case the first
    // line changed. Cheap and local.
    setLabelBump((b) => b + 1);
    onSaved?.();
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

      <RichEditor
        nodeId={nodeId}
        onSaved={handleSaved}
        onGraphChanged={onGraphChanged}
        onContentChange={onContentChange}
      />
    </section>
  );
}

export type EditorSaveState = SaveState;
