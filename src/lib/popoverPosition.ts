/**
 * Shared fixed-position + viewport-flip math for portal-rendered popovers
 * (dropdowns, pickers) anchored off a trigger element. Centralizes the
 * flip-up-near-the-bottom-of-the-window logic so every new popover doesn't
 * reinvent it (and doesn't crop off-screen the way an unflipped one does).
 */
export interface PopoverPos {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  flipUp: boolean;
}

export function computePopoverPos(
  anchor: HTMLElement,
  opts: { minWidth?: number; maxHeight: number },
): PopoverPos {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(Math.max(opts.minWidth ?? 0, rect.width), window.innerWidth - 16);

  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  const flipUp = spaceBelow < opts.maxHeight && spaceAbove > spaceBelow;

  // Right-edge clamp: keep the popover fully on-screen even when the anchor
  // sits near the right edge (the trigger can be much narrower than `width`).
  const left = Math.min(rect.left, window.innerWidth - width - 8);

  return flipUp
    ? { bottom: window.innerHeight - rect.top + 4, left, width, flipUp }
    : { top: rect.bottom + 4, left, width, flipUp };
}

// ── Tooltip placement (pure; rects in viewport px) ───────────────────────────

export type TooltipPlacement = "bottom" | "top" | "right" | "left";

export interface RectLike { top: number; left: number; right: number; bottom: number; width: number; height: number }

export interface TooltipPos { top: number; left: number; placement: TooltipPlacement }

const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = { bottom: "top", top: "bottom", right: "left", left: "right" };

/**
 * Place a tooltip of `size` next to `anchor`: on the preferred side, flipped to
 * the opposite side when it doesn't fit there (and fits better on the other),
 * then shifted along the cross axis to stay `margin` px inside the viewport.
 */
export function placeTooltip(
  anchor: RectLike,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  opts: { placement?: TooltipPlacement; gap?: number; margin?: number } = {},
): TooltipPos {
  const gap = opts.gap ?? 6;
  const margin = opts.margin ?? 8;
  const preferred = opts.placement ?? "bottom";

  const space: Record<TooltipPlacement, number> = {
    bottom: viewport.height - anchor.bottom - gap - margin,
    top: anchor.top - gap - margin,
    right: viewport.width - anchor.right - gap - margin,
    left: anchor.left - gap - margin,
  };
  const need = (p: TooltipPlacement) => (p === "top" || p === "bottom" ? size.height : size.width);

  let placement = preferred;
  const alt = OPPOSITE[preferred];
  if (space[preferred] < need(preferred) && space[alt] > space[preferred]) placement = alt;

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, Math.max(min, max)));

  if (placement === "top" || placement === "bottom") {
    const left = clamp(anchor.left + anchor.width / 2 - size.width / 2, margin, viewport.width - margin - size.width);
    const top = placement === "bottom" ? anchor.bottom + gap : anchor.top - gap - size.height;
    return { top, left, placement };
  }
  const top = clamp(anchor.top + anchor.height / 2 - size.height / 2, margin, viewport.height - margin - size.height);
  const left = placement === "right" ? anchor.right + gap : anchor.left - gap - size.width;
  return { top, left, placement };
}
