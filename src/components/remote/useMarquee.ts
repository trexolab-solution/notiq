import { useEffect, useRef, useState, type RefObject } from "react";

/** The rubber band being drawn, in the scroller's content coordinates (it scrolls with the rows). */
export interface MarqueeBox { x: number; y: number; w: number; h: number }

/** Smallest drag (px) that counts as drawing a band rather than a click on empty space. */
const THRESHOLD = 4;
/** Within this distance (px) of the top / bottom edge the list scrolls while the band is dragged. */
const EDGE = 28;
const SCROLL_STEP = 14;

/** The rows or tiles (`[data-name]`) a band, given in client coordinates, touches. */
export function namesUnder(scroller: HTMLElement, left: number, top: number, width: number, height: number): string[] {
  const names: string[] = [];
  scroller.querySelectorAll<HTMLElement>("[data-name]").forEach((n) => {
    const b = n.getBoundingClientRect();
    if (b.right > left && b.left < left + width && b.bottom > top && b.top < top + height && n.dataset.name) names.push(n.dataset.name);
  });
  return names;
}

/**
 * Click-and-drag selection on the empty space of a file list or grid, like a desktop file manager: a translucent band
 * is drawn and whatever it touches is selected (Ctrl / Cmd / Shift adds to the selection), and the list scrolls when
 * the pointer nears its top or bottom edge. A plain click on empty space clears the selection. Presses on a row,
 * button or the scrollbar are left alone, so dragging an item still moves it.
 *
 * `onChange(names, additive, base)`: `base` is the selection when the drag began (for the additive case).
 */
export function useMarquee(
  scroller: RefObject<HTMLElement | null>,
  getSelected: () => ReadonlySet<string>,
  onChange: (names: string[], additive: boolean, base: ReadonlySet<string>) => void,
): MarqueeBox | null {
  const [box, setBox] = useState<MarqueeBox | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const selected = useRef(getSelected);
  selected.current = getSelected;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const down = (e: PointerEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest("[data-name], button, a, input, textarea")) return;
      const r0 = el.getBoundingClientRect();
      if (e.clientX >= r0.left + el.clientWidth || e.clientY >= r0.top + el.clientHeight) return; // the scrollbar
      const additive = e.ctrlKey || e.metaKey || e.shiftKey;
      const base = new Set(selected.current());
      const startX = e.clientX - r0.left + el.scrollLeft;
      const startY = e.clientY - r0.top + el.scrollTop;
      let px = e.clientX, py = e.clientY, active = false, raf = 0;

      const apply = () => {
        const r = el.getBoundingClientRect();
        const cx = Math.max(0, Math.min(el.scrollWidth, px - r.left + el.scrollLeft));
        const cy = Math.max(0, Math.min(el.scrollHeight, py - r.top + el.scrollTop));
        const x = Math.min(startX, cx), y = Math.min(startY, cy), w = Math.abs(cx - startX), h = Math.abs(cy - startY);
        setBox({ x, y, w, h });
        change.current(namesUnder(el, r.left - el.scrollLeft + x, r.top - el.scrollTop + y, w, h), additive, base);
      };
      const tick = () => {
        const r = el.getBoundingClientRect();
        if (py < r.top + EDGE) el.scrollTop -= SCROLL_STEP;
        else if (py > r.bottom - EDGE) el.scrollTop += SCROLL_STEP;
        apply();
        raf = requestAnimationFrame(tick);
      };
      const move = (m: PointerEvent) => {
        px = m.clientX; py = m.clientY;
        if (!active && Math.hypot(px - e.clientX, py - e.clientY) >= THRESHOLD) {
          active = true;
          document.body.style.userSelect = "none";
          raf = requestAnimationFrame(tick);
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        cancelAnimationFrame(raf);
        document.body.style.userSelect = "";
        setBox(null);
        if (!active && !additive) change.current([], false, base); // a plain click on empty space clears
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    };
    el.addEventListener("pointerdown", down);
    return () => el.removeEventListener("pointerdown", down);
  }, [scroller]);

  return box;
}

/** The band as an element for the scroller (which must be `position: relative`). */
export const marqueeStyle = (b: MarqueeBox) => ({ left: b.x, top: b.y, width: b.w, height: b.h });
