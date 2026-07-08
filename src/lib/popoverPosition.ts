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
