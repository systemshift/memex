import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, CommitInfo } from "../api";

type Props = {
  nodeId: string;
  refreshKey: number;
};

/**
 * Per-node history. Walks memex-fs's commit log for commits where
 * this node's ref changed (created / edited / deleted) and lets the
 * user expand any entry to see the content as of that commit.
 *
 * Read-only view — "restore this version" is a later add. Copy out
 * of the expanded Markdown is the manual-restore path for now.
 */
export function HistoryTab({ nodeId, refreshKey }: Props) {
  const [entries, setEntries] = useState<CommitInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCid, setOpenCid] = useState<string | null>(null);
  const [openContent, setOpenContent] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await api.listNodeHistory(nodeId, 64);
        if (!cancelled) {
          setEntries(list);
          setOpenCid(null);
          setOpenContent("");
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId, refreshKey]);

  const toggle = async (cid: string) => {
    if (openCid === cid) {
      setOpenCid(null);
      setOpenContent("");
      return;
    }
    try {
      const text = await api.readNodeAt(nodeId, cid);
      setOpenCid(cid);
      setOpenContent(text);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="history-tab">
      {error && <p className="error">{error}</p>}
      {loading && <p className="muted empty">Loading commits…</p>}
      {!loading && entries.length === 0 && !error && (
        <p className="muted empty">
          No history yet. Every save here creates a commit — check back after
          you've edited this node a few times.
        </p>
      )}
      <ul className="history-list">
        {entries.map((e, i) => {
          const isOpen = e.cid === openCid;
          const ts = tryFormatTimestamp(e.timestamp);
          return (
            <li key={e.cid} className={`history-row ${isOpen ? "open" : ""}`}>
              <button className="history-header" onClick={() => toggle(e.cid)}>
                <span className="history-time">{ts}</span>
                <span className="history-msg">
                  {e.message || (i === entries.length - 1 ? "created" : "changed")}
                </span>
                <code className="history-cid">{e.cid.slice(0, 10)}…</code>
              </button>
              {isOpen && (
                <div className="history-preview">
                  {openContent.trim() ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {openContent}
                    </ReactMarkdown>
                  ) : (
                    <p className="muted empty">(empty content at this commit)</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function tryFormatTimestamp(raw: string): string {
  try {
    const d = new Date(raw);
    if (isNaN(d.getTime())) return raw;
    const now = Date.now();
    const diffMs = now - d.getTime();
    const hr = diffMs / 3_600_000;
    if (hr < 1) return `${Math.max(1, Math.round(diffMs / 60_000))}m ago`;
    if (hr < 24) return `${Math.round(hr)}h ago`;
    const days = hr / 24;
    if (days < 7) return `${Math.round(days)}d ago`;
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    });
  } catch {
    return raw;
  }
}
