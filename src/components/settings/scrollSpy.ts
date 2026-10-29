/**
 * Scroll spy for the Settings page: which section the left nav marks as current while the page scrolls.
 * The decision is a pure function (`pickActiveSection`) so it can be unit-tested; `observeSections` wires it
 * to IntersectionObserver (any section crossing the reading line re-runs the decision) plus a scroll fallback
 * for the very bottom of the page, where the last short sections never reach the line.
 */

export interface SectionBox<Id extends string = string> {
  id: Id;
  /** Top of the section relative to the top of the scroll viewport (px; negative = scrolled past). */
  top: number;
  /** Bottom of the section relative to the top of the viewport (px). */
  bottom: number;
}

export interface SpyViewport {
  /** Distance from the top of the viewport to the "reading line" (below the sticky header). */
  offset: number;
  /** Viewport height. */
  height: number;
  /** True when the container is scrolled to (within a few px of) its end. */
  atBottom: boolean;
}

/**
 * The current section: the last one whose top has reached the reading line. At the very bottom of the page
 * the last section that is visible at all wins (short trailing sections could never reach the line).
 * Before the first section reaches the line, the first section is current. `boxes` are in page order and
 * contain only rendered (non-hidden) sections; empty input → null.
 */
export function pickActiveSection<Id extends string>(boxes: SectionBox<Id>[], vp: SpyViewport): Id | null {
  if (!boxes.length) return null;
  if (vp.atBottom) {
    for (let i = boxes.length - 1; i >= 0; i--) {
      if (boxes[i].top < vp.height && boxes[i].bottom > vp.offset) return boxes[i].id;
    }
  }
  let current: Id = boxes[0].id;
  for (const b of boxes) {
    if (b.top <= vp.offset + 1) current = b.id;
    else break;
  }
  return current;
}

/** Whether a scroll container is at its end (tolerates sub-pixel rounding). */
export const isAtBottom = (el: { scrollTop: number; clientHeight: number; scrollHeight: number }, slack = 4) =>
  el.scrollTop + el.clientHeight >= el.scrollHeight - slack;

/**
 * Watches `sections` inside the scroll `root` and reports the current section id whenever it changes.
 * `getOffset` returns the reading-line offset (e.g. the sticky header's height). Returns a disposer.
 */
export function observeSections(
  root: HTMLElement,
  sections: () => HTMLElement[],
  getOffset: () => number,
  onChange: (id: string) => void,
): () => void {
  let last: string | null = null;
  let frame = 0;
  const compute = () => {
    frame = 0;
    const rootTop = root.getBoundingClientRect().top;
    const boxes: SectionBox[] = [];
    for (const el of sections()) {
      if (el.hidden || !el.offsetParent) continue; // filtered-out sections take no space
      const r = el.getBoundingClientRect();
      boxes.push({ id: el.dataset.section ?? el.id, top: r.top - rootTop, bottom: r.bottom - rootTop });
    }
    const id = pickActiveSection(boxes, { offset: getOffset(), height: root.clientHeight, atBottom: isAtBottom(root) });
    if (id && id !== last) { last = id; onChange(id); }
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(compute); };

  const io = typeof IntersectionObserver !== "undefined"
    ? new IntersectionObserver(schedule, { root, threshold: [0, 1], rootMargin: "0px 0px -40% 0px" })
    : null;
  for (const el of sections()) io?.observe(el);
  root.addEventListener("scroll", schedule, { passive: true });
  schedule();

  return () => {
    io?.disconnect();
    root.removeEventListener("scroll", schedule);
    if (frame) cancelAnimationFrame(frame);
  };
}
