import React, { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { LoaderCircle, type LucideIcon } from "lucide-react";

/*
 * ── Loading states: the one rule ───────────────────────────────────────────────
 *
 * Pick the treatment by how much room the control has, not by the operation:
 *
 * 1. Icon-only controls (title bar, activity bar, toolbars, sidebar headers, cramped status-bar items):
 *    the icon becomes a spinner (a refresh/sync icon spins itself instead), the width never changes,
 *    the tooltip + aria-label switch to the busy text ("Syncing…") and the button gets aria-busy.
 *    → `<BusyIcon>` + `busyIconProps()`.
 * 2. Text buttons: the spinner replaces the leading icon (or is prepended), the label switches to the
 *    progressive verb ("Sync now" → "Syncing…", "Open vault" → "Opening…"), the button keeps at least
 *    its idle width so the row doesn't jump, and it is disabled + aria-busy while busy.
 *    → `<Button loading loadingText>` / `<DialogButton loading loadingText>`.
 * 3. Inline / section loading (panels, lists, settings rows, dialogs): spinner + short label
 *    ("Checking your Google Drive…"), shown only after ~200 ms so fast work doesn't flash; past ~8 s
 *    it may add a secondary hint. → `<InlineLoading>`.
 * 4. Status-bar items with room: spinner + short label ("Syncing…", "Thinking…").
 *
 * Never a spinner alone without an accessible name. Reduced motion: spinners slow-pulse instead of
 * rotating (CSS media query + `useReducedMotion`), the label still says what's happening.
 * Copy: short, sentence case, progressive verb + "…" ("Checking…", "Restoring…").
 */

/** Delay before an inline loading state appears (fast operations never flash a spinner). */
export const LOADING_SHOW_DELAY_MS = 200;
/** After this long, an inline loading state may show its secondary "still working" hint. */
export const LOADING_SLOW_AFTER_MS = 8000;

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";
const readReduced = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED_QUERY).matches;

/** Live `prefers-reduced-motion: reduce`. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(readReduced);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_QUERY);
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

/** True once `active` has stayed true for `delayMs` (resets as soon as it turns false). */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [on, setOn] = useState(active && delayMs <= 0);
  useEffect(() => {
    if (!active) { setOn(false); return; }
    if (delayMs <= 0) { setOn(true); return; }
    const t = setTimeout(() => setOn(true), delayMs);
    return () => clearTimeout(t);
  }, [active, delayMs]);
  return active && on;
}

/** Class that animates any icon as a spinner (pulses instead under reduced motion, see ui.css). */
export const spinClass = (on: boolean | undefined) => (on ? "nq-spin" : "");

export interface SpinnerProps {
  size?: number;
  className?: string;
  /** Accessible name. Without it the spinner is decorative (`aria-hidden`): put the text next to it. */
  label?: string;
}

/** The app's spinner glyph. Decorative unless `label` is given. */
export function Spinner({ size = 14, className = "", label }: SpinnerProps) {
  const reduced = useReducedMotion();
  return (
    <LoaderCircle
      size={size}
      className={`nq-spinner shrink-0 ${reduced ? "nq-pulse" : "nq-spin"} ${className}`}
      data-reduced-motion={reduced ? "" : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

/**
 * An icon that shows it's busy without changing size: `spinSelf` icons (refresh / sync arrows) rotate,
 * anything else is swapped for a same-size spinner. Always decorative; name the control instead
 * (`busyIconProps`).
 */
export function BusyIcon({ icon: Icon, busy, spinSelf, size = 14, strokeWidth, className = "" }: {
  icon: LucideIcon; busy?: boolean; spinSelf?: boolean; size?: number; strokeWidth?: number; className?: string;
}) {
  if (busy && !spinSelf) return <Spinner size={size} className={className} />;
  return <Icon size={size} strokeWidth={strokeWidth} className={`shrink-0 ${spinClass(busy)} ${className}`} aria-hidden />;
}

/**
 * Accessible name + busy flag for an icon-only button: `label` normally, `busyLabel` while busy.
 * Pass `tooltip` to the button's Tooltip so it says the same thing.
 */
export function busyIconProps(busy: boolean | undefined, label: string, busyLabel: string) {
  const name = busy ? busyLabel : label;
  return { "aria-label": name, "aria-busy": busy ? true : undefined, tooltip: name } as const;
}

/**
 * Keeps a text button at least as wide as it was before `loading` turned on, so swapping the label for
 * "Syncing…" never makes the row jump. Returns a ref for the button and the style to merge.
 */
export function useLoadingWidth<T extends HTMLElement>(loading: boolean | undefined, style?: CSSProperties) {
  const ref = useRef<T | null>(null);
  const idle = useRef<number | null>(null);
  const [lock, setLock] = useState<number | null>(null);
  // Only buttons that opt in (`loading` passed at all) measure; measured while idle, before paint, so the
  // width is known the moment loading starts. The idle width already includes any caller min-width.
  const optedIn = loading !== undefined;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!optedIn || !el) return;
    if (!loading) {
      idle.current = el.getBoundingClientRect().width || null;
      if (lock != null) setLock(null);
    } else if (lock == null && idle.current) {
      setLock(idle.current);
    }
  });
  const merged: CSSProperties | undefined = loading && lock ? { ...style, minWidth: lock } : style;
  return { ref, style: merged };
}

/** Assigns one node to several refs. */
export function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]) {
  return (node: T | null) => {
    for (const r of refs) {
      if (typeof r === "function") r(node);
      else if (r) (r as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export interface InlineLoadingProps {
  /** Short, progressive: "Checking your Google Drive…". It's the accessible name too. */
  label: ReactNode;
  /** Wait this long before showing anything (default 200 ms). 0 shows immediately. */
  delay?: number;
  /** Secondary hint after `slowAfter` ms ("This can take a minute on slow connections."). */
  slowHint?: ReactNode;
  slowAfter?: number;
  size?: number;
  className?: string;
  /** Keep the row's height while waiting out the delay (dialogs / fixed panels), so nothing jumps. */
  reserveSpace?: boolean;
}

/** Section / panel / row loading: spinner + label after a short delay, with an optional slow hint. */
export function InlineLoading({
  label, delay = LOADING_SHOW_DELAY_MS, slowHint, slowAfter = LOADING_SLOW_AFTER_MS, size = 13, className = "", reserveSpace,
}: InlineLoadingProps) {
  const shown = useDelayedFlag(true, delay);
  const slow = useDelayedFlag(!!slowHint, slowAfter);
  if (!shown) {
    return reserveSpace
      ? <div className={`nq-inline-loading invisible ${className}`} aria-hidden data-pending=""><span className="nq-inline-loading__row">&nbsp;</span></div>
      : null;
  }
  return (
    <div className={`nq-inline-loading ${className}`} role="status" aria-live="polite">
      <span className="nq-inline-loading__row">
        <Spinner size={size} />
        <span>{label}</span>
      </span>
      {slow && slowHint && <span className="nq-inline-loading__hint">{slowHint}</span>}
    </div>
  );
}
