import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api } from "../api";
import { FileText, FolderOpen, X, Loader2 } from "../icons";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Invoked when ingest finishes with the ids created or reused. */
  onIngested: (ids: string[]) => void;
};

/**
 * Entry point for bringing external files into the graph. Two actions:
 * pick a single file, or pick a folder (optionally recursively). The
 * backend hashes each file, creates content-addressed nodes, and
 * — for text files — sets up the sync breadcrumb so edits on either
 * side stay in step.
 */
export function ImportDialog({ open, onClose, onIngested }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(true);
  const [summary, setSummary] = useState<{ count: number; first: string } | null>(
    null,
  );

  if (!open) return null;

  const doIngest = async (path: string, rec: boolean) => {
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      const ids = await api.ingestPath(path, rec);
      setSummary({ count: ids.length, first: ids[0] ?? "" });
      onIngested(ids);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    const selected = await openDialog({ multiple: false, directory: false });
    if (typeof selected === "string") {
      await doIngest(selected, false);
    }
  };

  const pickFolder = async () => {
    const selected = await openDialog({ multiple: false, directory: true });
    if (typeof selected === "string") {
      await doIngest(selected, recursive);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div
        className="modal import-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-header">
          <FolderOpen size={16} />
          <span className="modal-title">Import from disk</span>
          <div className="modal-spacer" />
          <button
            className="icon-btn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <section className="import-actions">
          <button className="import-row" onClick={pickFile} disabled={busy}>
            <FileText size={20} />
            <div>
              <div className="import-row-title">Import file</div>
              <div className="import-row-subtitle">
                Pick one file. Text files stay synced with their source;
                binaries are inlined for integrity.
              </div>
            </div>
          </button>

          <button className="import-row" onClick={pickFolder} disabled={busy}>
            <FolderOpen size={20} />
            <div>
              <div className="import-row-title">Import folder</div>
              <div className="import-row-subtitle">
                Walk a directory and ingest every file. Content-addressed
                nodes dedup if you import the same bytes twice.
              </div>
            </div>
          </button>

          <label className="import-option">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.currentTarget.checked)}
              disabled={busy}
            />
            <span>Recursive (walk subfolders)</span>
          </label>
        </section>

        {busy && (
          <div className="import-status">
            <Loader2 size={16} className="spin" /> Ingesting…
          </div>
        )}
        {error && <p className="error import-status">{error}</p>}
        {summary && !busy && (
          <div className="import-status import-success">
            Imported {summary.count} {summary.count === 1 ? "file" : "files"}.
            {summary.first && (
              <> First: <code>{summary.first}</code></>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
