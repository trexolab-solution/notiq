/**
 * Registry of in-app drop targets for OS file drag-and-drop.
 *
 * Tauri's native drag-drop (`getCurrentWebview().onDragDropEvent`) swallows the HTML5 drop, so the page
 * never sees `dataTransfer.files`. There is a single global listener (hooks/useAppStartup.ts) that by
 * default opens dropped files as tabs. A component that wants files dropped on it registers here; the
 * global listener hit-tests the event's position against the registered elements and, when one is hit,
 * hands it the paths instead of opening them.
 *
 * Tauri reports `position` in physical pixels relative to the webview; DOM rects are CSS pixels, so the
 * point is divided by `devicePixelRatio` (which also folds in the webview's zoom level) before testing.
 */

export interface Point { x: number; y: number }
export interface RectLike { left: number; top: number; right: number; bottom: number }

export interface DropTarget {
  id: string;
  /** The element whose box receives drops; null (or a zero-size box, e.g. a hidden tab) never matches. */
  element: () => Element | null;
  /** Checked on every hit-test: e.g. "vault unlocked and this entry is the active tab". */
  enabled: () => boolean;
  /** Called when a drag starts or stops hovering this target. */
  onHover?: (over: boolean) => void;
  /** The dropped paths (files and folders, as the OS gave them). */
  onDrop: (paths: string[]) => void;
}

/** Physical (device) pixels → CSS pixels. A missing or nonsensical scale counts as 1. */
export function toCssPoint(pos: Point, scale: number): Point {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return { x: pos.x / s, y: pos.y / s };
}

/** True when `p` lies inside `r` (left/top inclusive, right/bottom exclusive); empty rects contain nothing. */
export function rectContains(r: RectLike, p: Point): boolean {
  if (r.right <= r.left || r.bottom <= r.top) return false;
  return p.x >= r.left && p.x < r.right && p.y >= r.top && p.y < r.bottom;
}

/** The candidate under `p`; when several overlap, the smallest (most specific) one wins. */
export function pickTarget<T>(candidates: { target: T; rect: RectLike }[], p: Point): T | null {
  let best: T | null = null;
  let bestArea = Infinity;
  for (const { target, rect } of candidates) {
    if (!rectContains(rect, p)) continue;
    const area = (rect.right - rect.left) * (rect.bottom - rect.top);
    if (area < bestArea) { best = target; bestArea = area; }
  }
  return best;
}

const targets = new Map<string, DropTarget>();

/** Adds a target (replacing one with the same id); returns the unregister function. */
export function registerDropTarget(t: DropTarget): () => void {
  targets.set(t.id, t);
  return () => {
    if (targets.get(t.id) !== t) return;
    targets.delete(t.id);
    if (router.hovered === t) router.hovered = null;
  };
}

const defaultScale = () => (typeof window !== "undefined" ? window.devicePixelRatio : 1);

/** The enabled, registered target under a physical-pixel `position`, or null. */
export function findDropTarget(position: Point, scale = defaultScale()): DropTarget | null {
  const p = toCssPoint(position, scale);
  const candidates: { target: DropTarget; rect: RectLike }[] = [];
  for (const t of targets.values()) {
    const el = t.element();
    if (!el || !t.enabled()) continue;
    candidates.push({ target: t, rect: el.getBoundingClientRect() });
  }
  return pickTarget(candidates, p);
}

/** Tracks which target the drag is over, so targets get enter/leave callbacks. */
const router = {
  hovered: null as DropTarget | null,
  setHovered(next: DropTarget | null) {
    if (next === this.hovered) return;
    const prev = this.hovered;
    this.hovered = next;
    prev?.onHover?.(false);
    next?.onHover?.(true);
  },
};

/** Drag entered the window or moved: returns true while it is over a registered target. */
export function dragMove(position: Point, scale = defaultScale()): boolean {
  router.setHovered(findDropTarget(position, scale));
  return router.hovered !== null;
}

/** Drag left the window or was cancelled. */
export function dragLeave(): void {
  router.setHovered(null);
}

/**
 * Drop: delivers `paths` to the target under `position` and returns true, or returns false when no
 * target is there (the caller then does its default thing).
 */
export function dropAt(paths: string[], position: Point, scale = defaultScale()): boolean {
  const t = findDropTarget(position, scale);
  router.setHovered(null);
  if (!t) return false;
  t.onDrop(paths);
  return true;
}

/** Test helper: forget every target. */
export function clearDropTargets(): void {
  targets.clear();
  router.hovered = null;
}
