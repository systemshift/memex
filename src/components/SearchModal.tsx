import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { Search as SearchIcon, X } from "../icons";

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
};

/**
 * Cmd-Shift-F search modal. Queries memex-fs's /search/{query}/ view
 * with a short debounce so every keystroke doesn't spawn a dirent
 * read. Results show the human label with the raw id below, same
 * pattern as the sidebar.
 */
export function SearchModal({ open, onClose, onSelect }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labels = useNodeLabels(results, 0);

  useEffect(() => {
    if (!open) {
      setQ("");
      setResults([]);
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const query = q.trim();
    if (!query) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const ids = await api.searchNodes(query);
        if (cancelled) return;
        setResults(ids);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [q, open]);

  const hint = useMemo(() => {
    if (!q.trim()) return "Type a term to search the graph.";
    if (busy) return "Searching…";
    if (error) return error;
    if (results.length === 0) return "No matches.";
    return `${results.length} match${results.length === 1 ? "" : "es"}`;
  }, [q, busy, error, results.length]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal search-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <SearchIcon size={16} />
          <input
            className="modal-input"
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder="Search content…"
            autoFocus
          />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <p className="modal-hint">{hint}</p>
        <ul className="search-results">
          {results.map((id) => {
            const label = labels[id] ?? id;
            const showId = label !== id;
            return (
              <li key={id}>
                <button
                  className="search-row"
                  onClick={() => {
                    onSelect(id);
                    onClose();
                  }}
                >
                  <span className="search-label">{label}</span>
                  {showId && <span className="search-id">{id}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
