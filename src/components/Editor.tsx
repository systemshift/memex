import { useEffect, useState } from "react";
import { api } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { typeIcon } from "../icons";
import { RichEditor } from "./RichEditor";
import { FileViewer } from "./FileViewer";
import { ExtractButton } from "./ExtractButton";

type Props = {
  nodeId: string;
  /** Fires after every successful save. Cheap path — status bar only. */
  onSaved?: () => void;
  /** Fires when the save's [[refs]] set actually changed. */
  onGraphChanged?: () => void;
  /** Reports content length to the status bar for word count. */
  onContentChange?: (content: string) => void;
  /** Accepted for API symmetry; not forwarded. */
  refreshKey?: number;
};

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * Center column. Dispatches to RichEditor for text-ish nodes and to
 * FileViewer for binary nodes (PDFs / images / videos / audio / generic
 * files). We can't ask BlockNote to render PDF bytes as text — trying
 * would give the user garbage.
 */
export function Editor({ nodeId, onSaved, onGraphChanged, onContentChange }: Props) {
  const [typeName, setTypeName] = useState<string>("");
  const [mime, setMime] = useState<string>("");
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
        const [t, m] = await Promise.all([
          api.readNodeType(nodeId),
          api.readNodeMime(nodeId),
        ]);
        if (cancelled) return;
        setTypeName(t);
        setMime(m);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const handleSaved = () => {
    setLabelBump((b) => b + 1);
    onSaved?.();
  };

  const Icon = typeIcon(typeName);

  // Binary nodes render a FileViewer; text nodes (empty MIME counts as
  // text — that's the common case for user-created notes) render the
  // rich editor.
  const isBinary =
    mime && !mime.startsWith("text/") && !["application/json", "application/yaml", "application/xml"].includes(mime);

  return (
    <section className="editor-pane">
      <header className="editor-header">
        <div className="editor-title">
          <Icon size={16} className="editor-type-icon" />
          <span className="editor-label" title={nodeId}>{label}</span>
          {typeName && <span className="node-type-pill">{typeName}</span>}
          {showIdSub && <span className="editor-id-sub">{nodeId}</span>}
        </div>
        <ExtractButton nodeId={nodeId} onDone={onGraphChanged} />
      </header>

      {loadError && <p className="error" role="alert">{loadError}</p>}

      {isBinary ? (
        <FileViewer nodeId={nodeId} />
      ) : (
        <RichEditor
          nodeId={nodeId}
          onSaved={handleSaved}
          onGraphChanged={onGraphChanged}
          onContentChange={onContentChange}
        />
      )}
    </section>
  );
}

export type EditorSaveState = SaveState;
