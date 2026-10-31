// Framework-free logic shared by the React <Tooltip> and the vanilla-DOM
// `attachTooltip` helper: VS Code-style warm-up / cool-down timing, the
// "only one hover at a time" registry, input-modality tracking for
// focus-visible, and keybinding parsing. Kept pure (or nearly) so it can be
// unit-tested without a DOM.

/** Initial hover delay, matching VS Code's `workbench.hover.delay` default. */
export const TOOLTIP_SHOW_DELAY = 500;
/**
 * Cool-down: after a tooltip hides, the next one within this window appears
 * instantly — so sweeping across a toolbar doesn't re-wait the full delay.
 */
export const TOOLTIP_WARM_WINDOW = 400;

export interface WarmState {
  /** True while some tooltip is on screen. */
  visible: boolean;
  /** Timestamp (ms) the last visible tooltip was hidden; 0 = never. */
  lastHiddenAt: number;
}

/** Is the tooltip system "warm" (a hover is up, or one just closed)? */
export function isWarm(state: WarmState, now: number, warmWindow = TOOLTIP_WARM_WINDOW): boolean {
  if (state.visible) return true;
  return state.lastHiddenAt > 0 && now - state.lastHiddenAt < warmWindow;
}

/** Delay before showing a tooltip: 0 when warm, else `baseDelay`. */
export function showDelay(state: WarmState, now: number, baseDelay = TOOLTIP_SHOW_DELAY): number {
  return isWarm(state, now) ? 0 : Math.max(0, baseDelay);
}

export function markShown(state: WarmState): WarmState {
  return { ...state, visible: true };
}

/** Record a hide. Only a tooltip that was actually visible starts the cool-down. */
export function markHidden(state: WarmState, now: number, wasVisible: boolean): WarmState {
  if (!wasVisible) return state;
  return { visible: false, lastHiddenAt: now };
}

// ── Shared runtime state (one tooltip system per window) ─────────────────────

let warm: WarmState = { visible: false, lastHiddenAt: 0 };
/** Hide callback of the tooltip currently on screen (only one shows at a time). */
let activeHide: (() => void) | null = null;

export const tooltipRuntime = {
  delayFor(baseDelay?: number, now = Date.now()): number {
    return showDelay(warm, now, baseDelay ?? TOOLTIP_SHOW_DELAY);
  },
  /** Register `hide` as the visible tooltip, closing any other first. */
  shown(hide: () => void) {
    if (activeHide && activeHide !== hide) activeHide();
    activeHide = hide;
    warm = markShown(warm);
  },
  hidden(hide: () => void, now = Date.now()) {
    if (activeHide !== hide) return;
    activeHide = null;
    warm = markHidden(warm, now, true);
  },
  /** Test helper. */
  reset() { warm = { visible: false, lastHiddenAt: 0 }; activeHide = null; },
};

// ── Input modality (focus-visible heuristic) ─────────────────────────────────
// A tooltip opens on focus only when the focus came from the keyboard, like
// `:focus-visible` — a mouse click that focuses a button must not pop one.

let mouseDown = false;
let keyboardModality = false;

if (typeof document !== "undefined") {
  const opts = { capture: true, passive: true } as const;
  document.addEventListener("keydown", (e) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboardModality = true;
  }, opts);
  document.addEventListener("pointerdown", () => { keyboardModality = false; mouseDown = true; }, opts);
  document.addEventListener("mousedown", () => { keyboardModality = false; mouseDown = true; }, opts);
  document.addEventListener("pointerup", () => { mouseDown = false; }, opts);
  document.addEventListener("mouseup", () => { mouseDown = false; }, opts);
}

/** True while a mouse button is held (a click or drag is in progress). */
export function isMouseDown(): boolean { return mouseDown; }

/** Would this focus be `:focus-visible`? Prefers the real selector, falls back to modality. */
export function isFocusVisible(el: Element): boolean {
  try {
    if (el.matches(":focus-visible")) return true;
  } catch { /* selector unsupported */ }
  return keyboardModality;
}

// ── Keybindings ──────────────────────────────────────────────────────────────

/**
 * Parse a shortcut label into chords of keys for keybinding chips:
 * "Ctrl+Shift+`" → [["Ctrl","Shift","`"]], "Ctrl+K Ctrl+S" → two chords,
 * "Ctrl++" → [["Ctrl","+"]].
 */
export function parseShortcut(shortcut: string): string[][] {
  return shortcut
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((chord) => chord.split(/\+(?=.)/).map((k) => k.trim()).filter(Boolean));
}
