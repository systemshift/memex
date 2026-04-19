import { useCallback, useEffect, useState } from "react";

/**
 * Manage a list of open editor tabs. The active tab's id is what the
 * editor renders; opening an already-open node just activates that
 * tab instead of creating a duplicate.
 */
export function useTabs(initial: string) {
  const [tabs, setTabs] = useState<string[]>(initial ? [initial] : []);
  const [active, setActive] = useState<string>(initial);

  useEffect(() => {
    if (initial && tabs.length === 0) {
      setTabs([initial]);
      setActive(initial);
    }
  }, [initial, tabs.length]);

  const open = useCallback(
    (id: string) => {
      if (!id) return;
      setTabs((prev) => (prev.includes(id) ? prev : [...prev, id]));
      setActive(id);
    },
    [],
  );

  const close = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const idx = prev.indexOf(id);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t !== id);
        // If we closed the active tab, pick a neighbor. Prefer the
        // left neighbor (like Chrome) unless there is none.
        if (id === active) {
          const pick = next[idx - 1] ?? next[idx] ?? next[0] ?? "";
          setActive(pick);
        }
        return next;
      });
    },
    [active],
  );

  const activate = useCallback((id: string) => {
    setActive(id);
  }, []);

  const closeOthers = useCallback(
    (id: string) => {
      setTabs([id]);
      setActive(id);
    },
    [],
  );

  return { tabs, active, open, close, activate, closeOthers };
}
