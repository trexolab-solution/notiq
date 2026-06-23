import { useEffect, useRef } from "react";

/**
 * Calls `handler` whenever the Escape key is pressed while `enabled`.
 *
 * Replaces the hand-rolled `addEventListener("keydown", …)` + Escape-check +
 * cleanup that was duplicated across every modal/overlay. Pass `enabled = false`
 * to deactivate without unmounting (e.g. a drawer that's currently closed) —
 * the listener is only attached while enabled.
 */
export function useEscapeKey(handler: (e: KeyboardEvent) => void, enabled = true) {
  // Keep the latest handler in a ref so we only (un)subscribe when `enabled`
  // flips, never on every render that passes a fresh inline closure.
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") handlerRef.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
