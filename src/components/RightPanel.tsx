import { useEffect, useMemo, useState } from "react";
import { api, LinkInfo } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";

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
 * Each peer is rendered with a human label (meta.title, first line of
 * content, or humanized id) — the raw id is still accessible on hover.
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

  // Collect every peer id on display (dropping block suffixes so the
  // parent's label is used) into a single batch label fetch.
  const allIds = useMemo(() => {
    const set = new Set<string>();
    backlinks.forEach((l) => set.add(l.peer.split("#")[0]));
    neighbors.forEach((p) => set.add(p));
    outgoing.forEach((l) => set.add(l.peer.split("#")[0]));
    return Array.from(set);
  }, [backlinks, neighbors, outgoing]);

  const labels = useNodeLabels(allIds, refreshKey);

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
            labels={labels}
            onSelect={onSelect}
          />
        ))}
      </PanelSection>

      <PanelSection title="Neighbors" count={neighbors.length}>
        {neighbors.length === 0 && (
          <p className="muted empty">no related nodes yet</p>
        )}
        {neighbors.map((peer) => (
          <NodeRow key={peer} peer={peer} labels={labels} onSelect={onSelect} />
        ))}
      </PanelSection>

      <PanelSection title="Outgoing" count={outgoing.length}>
        {outgoing.length === 0 && <p className="muted empty">none</p>}
        {outgoing.map((l) => (
          <LinkRow
            key={l.link_type + l.peer}
            linkType={l.link_type}
            peer={l.peer}
            labels={labels}
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

/** One row with a link-type label and a clickable peer label + id. */
function LinkRow({
  linkType,
  peer,
  labels,
  onSelect,
}: {
  linkType: string;
  peer: string;
  labels: Record<string, string>;
  onSelect: (id: string) => void;
}) {
  // Block-scoped target like "paper:abc#b3" — navigate to the parent,
  // since we don't open block files directly yet.
  const parent = peer.split("#")[0];
  const label = labels[parent] ?? parent;
  const blockSuffix = peer.includes("#") ? peer.slice(peer.indexOf("#")) : "";
  const showingFallback = label === parent;
  return (
    <div className="link-row">
      <span className="link-type">{linkType}</span>
      <button
        className="peer"
        onClick={() => onSelect(parent)}
        title={peer}
      >
        <span className="peer-label">
          {label}
          {blockSuffix && <span className="peer-block">{blockSuffix}</span>}
        </span>
        {!showingFallback && <span className="peer-id-sub">{parent}</span>}
      </button>
    </div>
  );
}

function NodeRow({
  peer,
  labels,
  onSelect,
}: {
  peer: string;
  labels: Record<string, string>;
  onSelect: (id: string) => void;
}) {
  const label = labels[peer] ?? peer;
  const showingFallback = label === peer;
  return (
    <button className="peer row" onClick={() => onSelect(peer)} title={peer}>
      <span className="peer-label">{label}</span>
      {!showingFallback && <span className="peer-id-sub">{peer}</span>}
    </button>
  );
}
