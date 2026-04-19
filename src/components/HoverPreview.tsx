import { useEffect, useState } from "react";
import { api } from "../api";
import { typeIcon } from "../icons";

type Props = {
  /** The node id to preview. Empty string hides the preview entirely. */
  id: string;
  x: number;
  y: number;
};

/**
 * Floating preview card for a node. Pops up when a peer row is
 * hovered for ~300ms and shows the label, type, and first chunk of
 * content. Mirrors what Obsidian shows on hover over [[links]].
 *
 * Positioning is absolute on top of everything else; the caller
 * supplies cursor/element coordinates in viewport space.
 */
export function HoverPreview({ id, x, y }: Props) {
  const [content, setContent] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [typeName, setTypeName] = useState<string>("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [c, labels, t] = await Promise.all([
          api.readNode(id),
          api.readNodeLabels([id]),
          api.readNodeType(id),
        ]);
        if (cancelled) return;
        setContent(c);
        setLabel(labels[id] ?? id);
        setTypeName(t);
      } catch {
        if (!cancelled) setContent("");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) return null;

  const Icon = typeIcon(typeName);
  const preview = content.trim().slice(0, 400);
  const truncated = content.trim().length > preview.length;

  // Clamp to viewport so the preview doesn't escape the window.
  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.min(x + 12, window.innerWidth - 360),
    top: Math.min(y + 16, window.innerHeight - 200),
    zIndex: 1000,
  };

  return (
    <div className="hover-preview" style={style} role="tooltip">
      <header className="hover-head">
        <Icon size={13} />
        <span className="hover-label">{label}</span>
        {typeName && <span className="hover-type">{typeName}</span>}
      </header>
      <div className="hover-body">
        {loading && <span className="muted">Loading…</span>}
        {!loading && preview && <pre>{preview}{truncated ? "…" : ""}</pre>}
        {!loading && !preview && (
          <span className="muted">(no content yet)</span>
        )}
      </div>
      <footer className="hover-foot">
        <code>{id}</code>
      </footer>
    </div>
  );
}
