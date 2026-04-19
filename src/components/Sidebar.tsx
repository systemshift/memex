import { useEffect, useMemo, useState } from "react";
import { api, TypeInfo } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";

type Props = {
  currentId: string;
  onSelect: (id: string) => void;
  /** Bumped by the parent when anything structural changes so the sidebar
   *  re-queries memex-fs (new nodes created, etc.). */
  refreshKey: number;
  onNewNode: () => void;
};

type Expanded = Record<string, boolean>;

/**
 * Left column. Shows types as a tree; each type expands to its nodes.
 * A search box filters visible node ids across all expanded types.
 *
 * Node rows display a human-derived label with the raw id as secondary
 * text, so users see "Alice" instead of "person:alice-9f8a2b".
 */
export function Sidebar({ currentId, onSelect, refreshKey, onNewNode }: Props) {
  const [types, setTypes] = useState<TypeInfo[]>([]);
  const [nodesByType, setNodesByType] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Expanded>({});
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const t = await api.listTypes();
        setTypes(t);
        // Auto-expand the type of the current node so it's visible on load.
        if (currentId) {
          const currentType = await api.readNodeType(currentId);
          if (currentType) {
            setExpanded((prev) => ({ ...prev, [currentType]: true }));
          }
        }
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [refreshKey]);

  // Lazy-load nodes for a type the first time it's expanded.
  const toggleExpand = async (name: string) => {
    const next = !expanded[name];
    setExpanded((prev) => ({ ...prev, [name]: next }));
    if (next && !nodesByType[name]) {
      try {
        const ids = await api.listNodesByType(name);
        setNodesByType((prev) => ({ ...prev, [name]: ids }));
      } catch (e) {
        setError(String(e));
      }
    }
  };

  // Gather every currently-visible id for a single batch label fetch.
  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const [type, rows] of Object.entries(nodesByType)) {
      if (expanded[type]) ids.push(...rows);
    }
    return ids;
  }, [nodesByType, expanded]);

  const labels = useNodeLabels(visibleIds, refreshKey);

  const filterLower = filter.trim().toLowerCase();
  const filteredNodes = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [type, ids] of Object.entries(nodesByType)) {
      if (!filterLower) {
        out[type] = ids;
        continue;
      }
      // Filter on both the label and the raw id so either can find a node.
      const matches = ids.filter((id) => {
        const label = labels[id] ?? id;
        return (
          id.toLowerCase().includes(filterLower) ||
          label.toLowerCase().includes(filterLower)
        );
      });
      if (matches.length > 0) out[type] = matches;
    }
    return out;
  }, [nodesByType, filterLower, labels]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button className="btn-primary" onClick={onNewNode}>+ New node</button>
      </div>
      <div className="sidebar-search">
        <input
          type="search"
          placeholder="Filter…"
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
        />
      </div>
      {error && <p className="error sidebar-error">{error}</p>}
      <nav className="type-tree">
        {types.length === 0 && (
          <p className="muted empty">No nodes yet. Create one to start.</p>
        )}
        {types.map((t) => {
          const isOpen = !!expanded[t.name];
          const visible = isOpen ? filteredNodes[t.name] ?? [] : [];
          const hiddenByFilter =
            isOpen && filterLower && (nodesByType[t.name] ?? []).length > 0 && visible.length === 0;
          return (
            <div key={t.name} className="type-section">
              <button
                className={`type-header ${isOpen ? "open" : ""}`}
                onClick={() => toggleExpand(t.name)}
              >
                <span className="chevron">{isOpen ? "▾" : "▸"}</span>
                <span className="type-name">{t.name}</span>
                <span className="type-count">{t.count}</span>
              </button>
              {isOpen && (
                <ul className="node-list">
                  {hiddenByFilter && (
                    <li className="muted empty-filter">no matches</li>
                  )}
                  {visible.map((id) => {
                    const label = labels[id] ?? id;
                    const showingFallback = label === id;
                    return (
                      <li key={id}>
                        <button
                          className={`node-item ${id === currentId ? "active" : ""}`}
                          onClick={() => onSelect(id)}
                          title={id}
                        >
                          <span className="node-label">{label}</span>
                          {!showingFallback && (
                            <span className="node-id-sub">{id}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
