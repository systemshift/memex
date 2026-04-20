import { useEffect, useMemo, useState } from "react";
import { api, ClusterInfo } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { Sparkles, X, ChevronDown, ChevronRightSmall } from "../icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
};

/**
 * Browse the clusters memex-fs has surfaced from explicit authored
 * structure (mutual top-K neighbors across types, shared links,
 * etc.). Each cluster is a group of nodes that mutually rank each
 * other highly — a "shape" in the graph.
 *
 * Flat list for now: each cluster is collapsible and shows member
 * labels. Cluster naming (AI-generated) is a future refinement.
 */
export function ClustersModal({ open, onClose, onSelect }: Props) {
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const c = await api.listClusters();
        if (!cancelled) setClusters(c);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Batch-fetch labels for the first cluster's members; expansion
  // refills as needed via the same hook.
  const visibleMemberIds = useMemo(() => {
    const ids: string[] = [];
    for (const c of clusters) {
      if (expanded[c.id]) ids.push(...c.members);
    }
    return ids;
  }, [clusters, expanded]);

  const labels = useNodeLabels(visibleMemberIds, 0);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal clusters-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <Sparkles size={16} />
          <span className="modal-title">Emergent clusters</span>
          <div className="modal-spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        {error && <p className="error">{error}</p>}
        {loading && <p className="muted modal-hint">Loading…</p>}
        {!loading && !error && clusters.length === 0 && (
          <p className="muted modal-hint">
            No clusters yet. Clusters surface when groups of nodes mutually
            rank each other in their top neighbors — link a few things
            together and re-open.
          </p>
        )}
        <ul className="clusters-list">
          {clusters.map((c) => {
            const isOpen = !!expanded[c.id];
            return (
              <li key={c.id} className="cluster-row">
                <button
                  className="cluster-header"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [c.id]: !prev[c.id] }))
                  }
                >
                  {isOpen ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRightSmall size={13} />
                  )}
                  <span className="cluster-id">{c.id}</span>
                  <span className="cluster-size">
                    {c.members.length} members
                  </span>
                </button>
                {isOpen && (
                  <ul className="cluster-members">
                    {c.members.map((m) => {
                      const label = labels[m] ?? m;
                      const showId = label !== m;
                      return (
                        <li key={m}>
                          <button
                            className="cluster-member"
                            onClick={() => {
                              onSelect(m);
                              onClose();
                            }}
                          >
                            <span>{label}</span>
                            {showId && <span className="cluster-member-id">{m}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
