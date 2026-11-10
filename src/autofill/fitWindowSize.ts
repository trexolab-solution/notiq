/** Size limits of the autofill prompt window, in logical (DPI-independent) pixels. */
export interface WindowLimits { width: number; minHeight: number; maxHeight: number }

export const PROMPT_LIMITS: WindowLimits = { width: 420, minHeight: 160, maxHeight: 560 };

/**
 * The window size for content measured at `contentW` × `contentH` CSS pixels (= logical pixels).
 * The width is fixed; the height follows the content, rounded up so a fractional layout height never
 * produces a 1px scrollbar, and clamped to the limits (the body scrolls beyond the maximum).
 * Garbage input (NaN, negative) falls back to the minimum height.
 */
export function fitWindowSize(contentW: number, contentH: number, limits: WindowLimits = PROMPT_LIMITS): { width: number; height: number } {
  void contentW; // the width is fixed; kept in the signature so callers pass what they measured
  const h = Number.isFinite(contentH) && contentH > 0 ? Math.ceil(contentH) : limits.minHeight;
  return { width: limits.width, height: Math.min(limits.maxHeight, Math.max(limits.minHeight, h)) };
}

/** True when a resize is worth doing (ignores sub-pixel jitter from the observer). */
export function sizeChanged(prev: { width: number; height: number } | null, next: { width: number; height: number }): boolean {
  return !prev || Math.abs(prev.width - next.width) >= 1 || Math.abs(prev.height - next.height) >= 1;
}
