import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser-style back/forward history for node navigation. The current
 * index slides through a linear stack; navigating forward/backward
 * moves through it without mutating entries.
 *
 * When the user picks a node that isn't adjacent to the current index
 * (e.g. via the sidebar), the forward-stack is truncated — same as a
 * browser's "click a link, lose the forward history" convention.
 */
export function useHistory(initial: string) {
  const [stack, setStack] = useState<string[]>(initial ? [initial] : []);
  const [index, setIndex] = useState(initial ? 0 : -1);
  // Suppress the auto-push that runs when navigating back/forward —
  // setCurrent would otherwise clobber the stack every step.
  const suppress = useRef(false);

  const current = index >= 0 ? stack[index] : "";

  const go = useCallback(
    (id: string) => {
      if (!id) return;
      if (id === current) return;
      if (suppress.current) {
        suppress.current = false;
        return;
      }
      setStack((prev) => {
        const head = prev.slice(0, index + 1);
        head.push(id);
        return head;
      });
      setIndex((i) => i + 1);
    },
    [current, index],
  );

  const canBack = index > 0;
  const canForward = index < stack.length - 1;

  const back = useCallback(() => {
    if (!canBack) return;
    suppress.current = true;
    setIndex((i) => i - 1);
  }, [canBack]);

  const forward = useCallback(() => {
    if (!canForward) return;
    suppress.current = true;
    setIndex((i) => i + 1);
  }, [canForward]);

  // Reset the stack when the parent supplies a brand-new initial id
  // (e.g. on first mount with a freshly resolved daily note id).
  useEffect(() => {
    if (initial && stack.length === 0) {
      setStack([initial]);
      setIndex(0);
    }
  }, [initial, stack.length]);

  return { current, go, back, forward, canBack, canForward };
}
