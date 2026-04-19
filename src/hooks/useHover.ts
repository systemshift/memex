import { useEffect, useRef, useState } from "react";

export type HoverTarget = {
  id: string;
  x: number;
  y: number;
};

/**
 * Debounced hover tracker for peer rows. When the user hovers a row
 * for the configured delay, returns `{id, x, y}`. Moving off the row
 * before the delay elapses cancels; moving to a different row resets
 * the timer so you only ever see one preview at a time.
 */
export function useHover(delayMs: number = 400) {
  const [target, setTarget] = useState<HoverTarget | null>(null);
  const pending = useRef<{ id: string; ev: MouseEvent | React.MouseEvent } | null>(
    null,
  );
  const timer = useRef<number | null>(null);

  const clear = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };

  const onEnter = (id: string) => (e: React.MouseEvent) => {
    clear();
    pending.current = { id, ev: e };
    const x = e.clientX;
    const y = e.clientY;
    timer.current = window.setTimeout(() => {
      setTarget({ id, x, y });
    }, delayMs);
  };

  const onLeave = () => {
    clear();
    setTarget(null);
  };

  useEffect(() => () => clear(), []);

  return { target, onEnter, onLeave };
}
