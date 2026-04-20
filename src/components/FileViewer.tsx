import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openPath } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { typeIcon, FileText, FolderOpen } from "../icons";

type Props = {
  nodeId: string;
};

type Meta = {
  mime?: string;
  basename?: string;
  source_path?: string;
  size_bytes?: number;
  extracted_text?: string;
  is_text?: boolean;
};

/**
 * Rendered instead of the rich editor for binary nodes. Shows the
 * file's basename, MIME, size, a preview of any extracted plaintext
 * (PDF today — other formats later), and an "open in default app"
 * button so the user can reach the real source.
 *
 * This is deliberately read-only. Binary nodes don't get edited from
 * inside memex; notes ABOUT a PDF go in separate linked nodes.
 */
export function FileViewer({ nodeId }: Props) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [typeName, setTypeName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, t] = await Promise.all([
          api.readNodeMeta(nodeId) as unknown as Promise<Meta>,
          api.readNodeType(nodeId),
        ]);
        if (cancelled) return;
        setMeta(m);
        setTypeName(t);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nodeId]);

  const Icon = typeIcon(typeName);
  const size = useMemo(() => {
    const b = meta?.size_bytes ?? 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }, [meta?.size_bytes]);

  const onOpenExternal = async () => {
    if (!meta?.source_path) return;
    try {
      await openPath(meta.source_path);
    } catch (e) {
      setError(String(e));
    }
  };

  if (error) {
    return (
      <section className="file-viewer">
        <p className="error">{error}</p>
      </section>
    );
  }
  if (!meta) {
    return (
      <section className="file-viewer">
        <p className="muted">Loading…</p>
      </section>
    );
  }

  return (
    <section className="file-viewer">
      <header className="file-header">
        <Icon size={20} className="file-icon" />
        <div className="file-meta">
          <div className="file-name">{meta.basename ?? nodeId}</div>
          <div className="file-sub">
            {meta.mime && <span>{meta.mime}</span>}
            {meta.size_bytes ? <span> · {size}</span> : null}
          </div>
          {meta.source_path && (
            <code className="file-path">{meta.source_path}</code>
          )}
        </div>
        {meta.source_path && (
          <button className="btn-secondary" onClick={onOpenExternal}>
            <FolderOpen size={14} /> Open externally
          </button>
        )}
      </header>

      <div className="file-body">
        {meta.extracted_text ? (
          <>
            <div className="file-section-label">
              <FileText size={12} /> Extracted text
            </div>
            <div className="file-extracted">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {meta.extracted_text}
              </ReactMarkdown>
            </div>
          </>
        ) : (
          <p className="muted empty file-empty">
            No text extracted from this file. You can still open it
            externally, ask the chat about it (using filename + context),
            or create notes linked to it.
          </p>
        )}
      </div>
    </section>
  );
}
