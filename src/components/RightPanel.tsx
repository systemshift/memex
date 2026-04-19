import { useEffect, useState } from "react";
import { api, LinkInfo } from "../api";

type Props = {
  nodeId: string;
  /** Bumped by the parent whenever the current node's data changes
   *  (e.g. after a save that might have created [[refs]]). */
  refreshKey: number;
  onSelect: (id: string) => void;
};

/**
 * Right column. Three sections:
 *   - Backlinks: who points at this node (bubbled up from block-scoped
 *     targets too, memex-fs handles that in its reverse-index).
 *   - Neighbors: ranked multi-signal relevance from memex-fs.
 *   - Outgoing links: what this node points at, by link type.
 *
 * Every peer id is clickable and navigates to that node.
 */
export function RightPanel({ nodeId, refreshKey, onSelect }: Props) {
  const [backlinks, setBacklinks] = useState<LinkInfo[]>([]);
  const [neighbors, setNeighbors] = useState<string[]>([]);
  const [outgoing, setOutgoing] = useState<LinkInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setError(null);
      try {
        const [bl, nb, og] = await Promise.all([
          api.readBacklinks(nodeId),
          api.readNeighbors(nodeId),
          api.readOutgoingLinks(nodeId),
        ]);
        if (cancelled) return;
        setBacklinks(bl);
        setNeighbors(nb);
        setOutgoing(og);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId, refreshKey]);

  return (
    <aside className="right-panel">
      {error && <p className="error">{error}</p>}

      <PanelSection title="Backlinks" count={backlinks.length}>
        {backlinks.length === 0 && <p className="muted empty">none</p>}
        {backlinks.map((l) => (
          <LinkRow
            key={l.link_type + l.peer}
            linkType={l.link_type}
            peer={l.peer}
            onSelect={onSelect}
          />
        ))}
      </PanelSection>

      <PanelSection title="Neighbors" count={neighbors.length}>
        {neighbors.length === 0 && (
          <p className="muted empty">no related nodes yet</p>
        )}
        {neighbors.map((peer) => (
          <NodeRow key={peer} peer={peer} onSelect={onSelect} />
        ))}
      </PanelSection>

      <PanelSection title="Outgoing" count={outgoing.length}>
        {outgoing.length === 0 && <p className="muted empty">none</p>}
        {outgoing.map((l) => (
          <LinkRow
            key={l.link_type + l.peer}
            linkType={l.link_type}
            peer={l.peer}
            onSelect={onSelect}
          />
        ))}
      </PanelSection>
    </aside>
  );
}

function PanelSection({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="panel-section">
      <header className="panel-section-header">
        <span className="panel-title">{title}</span>
        <span className="panel-count">{count}</span>
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

/** One row with a link-type label and a clickable peer id. */
function LinkRow({
  linkType,
  peer,
  onSelect,
}: {
  linkType: string;
  peer: string;
  onSelect: (id: string) => void;
}) {
  // Block-scoped target like "paper:abc#b3" — navigate to the parent,
  // since we don't open block files directly yet.
  const parent = peer.split("#")[0];
  return (
    <div className="link-row">
      <span className="link-type">{linkType}</span>
      <button
        className="peer-id"
        onClick={() => onSelect(parent)}
        title={peer}
      >
        {peer}
      </button>
    </div>
  );
}

function NodeRow({
  peer,
  onSelect,
}: {
  peer: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button className="peer-id row" onClick={() => onSelect(peer)} title={peer}>
      {peer}
    </button>
  );
}
