import { useEffect, useMemo, useState } from "react";
import { api, LinkInfo } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { useHover } from "../hooks/useHover";
import { ChatPanel } from "./ChatPanel";
import { HoverPreview } from "./HoverPreview";
import { HistoryTab } from "./HistoryTab";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Compass,
  Network,
  MessageSquare,
  Calendar,
} from "../icons";

type Props = {
  nodeId: string;
  refreshKey: number;
  onSelect: (id: string) => void;
};

type Tab = "graph" | "chat" | "history";

/**
 * Right column with three tabs. Graph lists this node's backlinks,
 * ranked neighbors, and outgoing links. Chat is the context-aware
 * assistant. History walks this node's commit log and lets the user
 * inspect any past revision read-only.
 */
export function RightPanel({ nodeId, refreshKey, onSelect }: Props) {
  const [tab, setTab] = useState<Tab>("graph");

  return (
    <aside className="right-panel">
      <div className="right-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "graph"}
          className={`right-tab ${tab === "graph" ? "active" : ""}`}
          onClick={() => setTab("graph")}
        >
          <Network size={13} /> Graph
        </button>
        <button
          role="tab"
          aria-selected={tab === "chat"}
          className={`right-tab ${tab === "chat" ? "active" : ""}`}
          onClick={() => setTab("chat")}
        >
          <MessageSquare size={13} /> Chat
        </button>
        <button
          role="tab"
          aria-selected={tab === "history"}
          className={`right-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          <Calendar size={13} /> History
        </button>
      </div>
      {tab === "graph" && (
        <GraphTab
          nodeId={nodeId}
          refreshKey={refreshKey}
          onSelect={onSelect}
        />
      )}
      {tab === "chat" && <ChatPanel key={nodeId} nodeId={nodeId} />}
      {tab === "history" && (
        <HistoryTab nodeId={nodeId} refreshKey={refreshKey} />
      )}
    </aside>
  );
}

function GraphTab({ nodeId, refreshKey, onSelect }: Props) {
  const [backlinks, setBacklinks] = useState<LinkInfo[]>([]);
  const [neighbors, setNeighbors] = useState<string[]>([]);
  const [outgoing, setOutgoing] = useState<LinkInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hover = useHover(300);

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

  const allIds = useMemo(() => {
    const set = new Set<string>();
    backlinks.forEach((l) => set.add(l.peer.split("#")[0]));
    neighbors.forEach((p) => set.add(p));
    outgoing.forEach((l) => set.add(l.peer.split("#")[0]));
    return Array.from(set);
  }, [backlinks, neighbors, outgoing]);

  const labels = useNodeLabels(allIds, refreshKey);

  return (
    <div className="graph-tab">
      {error && <p className="error">{error}</p>}

      <PanelSection
        title="Backlinks"
        count={backlinks.length}
        icon={<ArrowDownLeft size={13} />}
        emptyHint="Nothing points here yet. Use [[this-node-id]] elsewhere to start a thread."
      >
        {backlinks.map((l) => (
          <LinkRow
            key={l.link_type + l.peer}
            linkType={l.link_type}
            peer={l.peer}
            labels={labels}
            onSelect={onSelect}
            hover={hover}
          />
        ))}
      </PanelSection>

      <PanelSection
        title="Neighbors"
        count={neighbors.length}
        icon={<Compass size={13} />}
        emptyHint="No related nodes yet. Neighbors emerge from explicit links, shared types, and co-change."
      >
        {neighbors.map((peer) => (
          <NodeRow
            key={peer}
            peer={peer}
            labels={labels}
            onSelect={onSelect}
            hover={hover}
          />
        ))}
      </PanelSection>

      <PanelSection
        title="Outgoing"
        count={outgoing.length}
        icon={<ArrowUpRight size={13} />}
        emptyHint="This node doesn't reference anything yet."
      >
        {outgoing.map((l) => (
          <LinkRow
            key={l.link_type + l.peer}
            linkType={l.link_type}
            peer={l.peer}
            labels={labels}
            onSelect={onSelect}
            hover={hover}
          />
        ))}
      </PanelSection>

      {hover.target && (
        <HoverPreview
          id={hover.target.id}
          x={hover.target.x}
          y={hover.target.y}
        />
      )}
    </div>
  );
}

function PanelSection({
  title,
  count,
  icon,
  children,
  emptyHint,
}: {
  title: string;
  count: number;
  icon: React.ReactNode;
  children: React.ReactNode;
  emptyHint: string;
}) {
  const isEmpty = count === 0;
  return (
    <section className="panel-section">
      <header className="panel-section-header">
        <span className="panel-title">
          {icon} {title}
        </span>
        <span className="panel-count">{count}</span>
      </header>
      <div className="panel-body">
        {isEmpty ? <p className="muted empty">{emptyHint}</p> : children}
      </div>
    </section>
  );
}

function LinkRow({
  linkType,
  peer,
  labels,
  onSelect,
  hover,
}: {
  linkType: string;
  peer: string;
  labels: Record<string, string>;
  onSelect: (id: string) => void;
  hover: ReturnType<typeof useHover>;
}) {
  const parent = peer.split("#")[0];
  const label = labels[parent] ?? parent;
  const blockSuffix = peer.includes("#") ? peer.slice(peer.indexOf("#")) : "";
  const showingFallback = label === parent;
  return (
    <div
      className="link-row"
      onMouseEnter={hover.onEnter(parent)}
      onMouseLeave={hover.onLeave}
    >
      <span className="link-type">{linkType}</span>
      <button className="peer" onClick={() => onSelect(parent)} title={peer}>
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
  hover,
}: {
  peer: string;
  labels: Record<string, string>;
  onSelect: (id: string) => void;
  hover: ReturnType<typeof useHover>;
}) {
  const label = labels[peer] ?? peer;
  const showingFallback = label === peer;
  return (
    <button
      className="peer row"
      onClick={() => onSelect(peer)}
      title={peer}
      onMouseEnter={hover.onEnter(peer)}
      onMouseLeave={hover.onLeave}
    >
      <span className="peer-label">{label}</span>
      {!showingFallback && <span className="peer-id-sub">{peer}</span>}
    </button>
  );
}
