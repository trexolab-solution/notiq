// Viewport math for ContextMenu, kept pure so it can be unit tested.

const PAD = 8;

/**
 * Place a `w`×`h` menu at the cursor, flipping left / up when it would run off the
 * right / bottom edge, and pinning it inside the viewport when it can't fit either way.
 */
export function clampMenuPosition(x: number, y: number, w: number, h: number, vw: number, vh: number) {
  const fit = (p: number, size: number, view: number) => {
    if (p + size <= view - PAD) return Math.max(PAD, p);
    if (p - size >= PAD) return p - size;
    return Math.max(PAD, view - PAD - size);
  };
  return { left: fit(x, w, vw), top: fit(y, h, vh) };
}

/**
 * Next focusable index after `from` in direction `dir` (wrapping), skipping
 * separators, labels and disabled items. `from = -1` starts at the first/last item.
 * Returns -1 when nothing is focusable.
 */
export function nextFocusIndex(enabled: boolean[], from: number, dir: 1 | -1): number {
  const n = enabled.length;
  if (!enabled.some(Boolean)) return -1;
  let i = from < 0 ? (dir === 1 ? -1 : n) : from;
  for (let step = 0; step < n; step++) {
    i = (i + dir + n) % n;
    if (enabled[i]) return i;
  }
  return -1;
}
