import { useEffect, useMemo, useState } from "react";
import { api, TypeInfo } from "../api";

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
 * Data comes entirely from memex-fs via /types/ — no local state about
 * what nodes exist. Refresh by bumping refreshKey.
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

  // Flat list of visible ids (for filter matching) — computed on every
  // render but cheap since it's just string membership checks.
  const filterLower = filter.trim().toLowerCase();
  const filteredNodes = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const [type, ids] of Object.entries(nodesByType)) {
      if (!filterLower) {
        out[type] = ids;
        continue;
      }
      const matches = ids.filter((id) => id.toLowerCase().includes(filterLower));
      if (matches.length > 0) out[type] = matches;
    }
    return out;
  }, [nodesByType, filterLower]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <button className="btn-primary" onClick={onNewNode}>+ New node</button>
      </div>
      <div className="sidebar-search">
        <input
          type="search"
          placeholder="Filter nodes…"
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
                  {visible.map((id) => (
                    <li key={id}>
                      <button
                        className={`node-item ${id === currentId ? "active" : ""}`}
                        onClick={() => onSelect(id)}
                        title={id}
                      >
                        {id}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
