import { X } from "../icons";
import { typeIcon } from "../icons";
import { useNodeLabels } from "../hooks/useNodeLabels";
import { useEffect, useState } from "react";
import { api } from "../api";

type Props = {
  tabs: string[];
  active: string;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  refreshKey: number;
};

/**
 * Horizontal tab strip above the editor. Each open node gets a tab
 * with its type icon, label, and a close affordance. Middle-click on
 * a tab also closes it (browser convention).
 */
export function EditorTabs({ tabs, active, onActivate, onClose, refreshKey }: Props) {
  const labels = useNodeLabels(tabs, refreshKey);
  const [types, setTypes] = useState<Record<string, string>>({});

  // Fetch each tab's type once; labels hook handles labels.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const missing = tabs.filter((t) => !(t in types));
      if (missing.length === 0) return;
      const pairs = await Promise.all(
        missing.map(async (id) => {
          try {
            return [id, await api.readNodeType(id)] as const;
          } catch {
            return [id, ""] as const;
          }
        }),
      );
      if (cancelled) return;
      setTypes((prev) => {
        const next = { ...prev };
        for (const [id, t] of pairs) next[id] = t;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [tabs.join("|")]);

  if (tabs.length === 0) return null;

  return (
    <div className="editor-tabs" role="tablist">
      {tabs.map((id) => {
        const Icon = typeIcon(types[id]);
        const label = labels[id] ?? id;
        const isActive = id === active;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={isActive}
            className={`editor-tab ${isActive ? "active" : ""}`}
            onClick={() => onActivate(id)}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                onClose(id);
              }
            }}
            title={id}
          >
            <Icon size={13} className="tab-icon" />
            <span className="tab-label">{label}</span>
            <button
              className="tab-close"
              aria-label={`Close ${label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
