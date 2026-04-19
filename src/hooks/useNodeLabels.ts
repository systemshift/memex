import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

/**
 * Given a set of ids, batch-fetch their human labels from the backend.
 * Each id that doesn't have a label yet is fetched once; subsequent
 * renders with the same ids reuse the cached value. The returned
 * lookup always falls back to the id itself, so callers can render
 * `labels[id] ?? id` without a nullish check.
 *
 * `bump` is an optional revision counter — increment it to force a
 * refetch (e.g. after a save that changed meta or content).
 */
export function useNodeLabels(ids: string[], bump: number = 0) {
  const [labels, setLabels] = useState<Record<string, string>>({});

  // Deduplicate and stabilize the key so we don't refetch on array
  // identity changes alone.
  const unique = useMemo(() => {
    const set = new Set(ids);
    return Array.from(set).sort();
  }, [ids.join("|")]);

  useEffect(() => {
    if (unique.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const next = await api.readNodeLabels(unique);
        if (!cancelled) {
          setLabels((prev) => ({ ...prev, ...next }));
        }
      } catch {
        // Silently fall back to raw ids; not worth surfacing in UI.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [unique.join("|"), bump]);

  return labels;
}
