import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { ForceGraphMethods } from "react-force-graph-2d";
import { api, GraphData } from "../api";
import { X, Network } from "../icons";

type Props = {
  open: boolean;
  onClose: () => void;
  centerId: string;
  onSelect: (id: string) => void;
};

/**
 * Force-directed neighborhood view centered on the current node.
 * Shows up to `hops` steps out in any direction (outgoing + incoming
 * combined); node positions are produced by d3-force via
 * react-force-graph-2d. Clicking a node navigates to it (and closes
 * the modal so the main shell can take over).
 *
 * The hop slider lets users zoom out — 1 hop is the immediate
 * neighborhood, 3 hops is usually hundreds of nodes and the layout
 * starts to look like a hairball.
 */
export function GraphViewModal({ open, onClose, centerId, onSelect }: Props) {
  const [hops, setHops] = useState(2);
  const [data, setData] = useState<GraphData>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<ForceGraphMethods | undefined>(undefined);

  // Fetch the neighborhood whenever the modal opens, the center
  // changes, or the hop budget is adjusted.
  useEffect(() => {
    if (!open || !centerId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const g = await api.neighborhoodGraph(centerId, hops);
        if (!cancelled) setData(g);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, centerId, hops]);

  // ForceGraph expects `{ nodes, links }` where links carry `source`
  // and `target` as node ids. We also carry color and size.
  const graphData = useMemo(() => {
    return {
      nodes: data.nodes.map((n) => ({
        id: n.id,
        name: n.label,
        type: n.type_name,
        isCenter: n.is_center,
      })),
      links: data.edges.map((e) => ({
        source: e.source,
        target: e.target,
        label: e.link_type,
      })),
    };
  }, [data]);

  // Zoom-to-fit once the layout settles.
  useEffect(() => {
    if (!open || graphData.nodes.length === 0) return;
    const t = window.setTimeout(() => {
      ref.current?.zoomToFit(400, 60);
    }, 600);
    return () => window.clearTimeout(t);
  }, [open, graphData.nodes.length]);

  if (!open) return null;

  return (
    <div className="modal-backdrop graph-backdrop" onClick={onClose}>
      <div
        className="modal graph-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <Network size={16} />
          <span className="modal-title">Graph — {centerId}</span>
          <div className="graph-controls">
            <label>
              hops
              <input
                type="range"
                min={1}
                max={3}
                value={hops}
                onChange={(e) => setHops(parseInt(e.currentTarget.value, 10))}
              />
              <span className="graph-hop-value">{hops}</span>
            </label>
            <span className="muted graph-count">
              {data.nodes.length} nodes · {data.edges.length} edges
              {data.nodes.length >= 200 && " (capped)"}
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="graph-canvas">
          {error && <p className="error">{error}</p>}
          {loading && data.nodes.length === 0 && (
            <p className="muted graph-loading">Laying out…</p>
          )}
          {!loading && data.nodes.length === 0 && !error && (
            <p className="muted graph-loading">
              No neighborhood yet. Link this node to others to grow the graph.
            </p>
          )}
          {data.nodes.length > 0 && (
            <ForceGraph2D
              ref={ref}
              graphData={graphData}
              nodeLabel={(n: any) => `${n.name}\n${n.id}`}
              nodeRelSize={6}
              nodeColor={(n: any) =>
                n.isCenter ? "#6aa1ff" : typeColor(n.type)
              }
              linkColor={() => "rgba(128,128,128,0.35)"}
              linkDirectionalArrowLength={3}
              linkDirectionalArrowRelPos={1}
              nodeCanvasObjectMode={() => "after"}
              nodeCanvasObject={(node: any, ctx, globalScale) => {
                const label = node.name;
                const fontSize = Math.max(10 / globalScale, 3.5);
                ctx.font = `${fontSize}px Inter, sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                ctx.fillStyle = "#6b7078";
                ctx.fillText(label, node.x, node.y + 8);
              }}
              cooldownTicks={120}
              onNodeClick={(n: any) => {
                onSelect(n.id);
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Picks a distinguishable color per node type. Purely perceptual —
 *  no semantic meaning to the hue. */
function typeColor(typeName: string): string {
  const palette = [
    "#e07a5f", // warm orange — Daily
    "#81b29a", // sage — Person
    "#7aa8d8", // sky — Paper
    "#c3a2d1", // lilac — Concept
    "#e9c46a", // gold — Note
    "#f4a261", // amber — Claim
    "#a98467", // clay — Post
    "#6aa1ff", // accent reserved for center node
    "#9fb8a5", // muted green — Source
    "#b8a89b", // neutral — default
  ];
  if (!typeName) return palette[9];
  let hash = 0;
  for (let i = 0; i < typeName.length; i++) {
    hash = (hash * 31 + typeName.charCodeAt(i)) >>> 0;
  }
  // Skip slot 7 (accent) for non-center nodes.
  const candidates = palette.filter((_, i) => i !== 7);
  return candidates[hash % candidates.length];
}
