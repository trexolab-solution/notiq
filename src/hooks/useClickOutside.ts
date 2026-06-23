import { useEffect, useRef } from "react";
import type { RefObject } from "react";

type ElementRef = RefObject<HTMLElement | null>;

/**
 * Calls `handler` on a `mousedown` that lands outside every element in `refs`.
 *
 * Replaces the duplicated `if (ref.current && !ref.current.contains(target))`
 * dropdown/menu close logic. Accepts a single ref or a list (e.g. a trigger
 * plus its portalled popover). Pass `enabled = false` while the popover is
 * closed so no global listener is attached.
 */
export function useClickOutside(
  refs: ElementRef | ElementRef[],
  handler: (e: MouseEvent) => void,
  enabled = true,
) {
  // Refs so the effect only re-subscribes when `enabled` changes, not when a
  // caller passes a fresh inline handler or `[a, b]` array literal each render.
  const handlerRef = useRef(handler);
  const refsRef = useRef(refs);
  handlerRef.current = handler;
  refsRef.current = refs;

  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const list = Array.isArray(refsRef.current) ? refsRef.current : [refsRef.current];
      const inside = list.some((r) => r.current?.contains(target));
      if (!inside) handlerRef.current(e);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [enabled]);
}
