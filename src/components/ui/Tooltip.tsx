import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { placeTooltip, type TooltipPlacement, type TooltipPos } from "../../lib/popoverPosition";
import { isFocusVisible, isMouseDown, parseShortcut, tooltipRuntime } from "../../lib/tooltipLogic";

export type { TooltipPlacement };

interface TooltipProps {
  /** Main label shown in the tooltip */
  content: React.ReactNode;
  /** Optional keyboard shortcut, rendered as keybinding chips ("Ctrl+Shift+N", chords "Ctrl+K Ctrl+S") */
  shortcut?: string;
  /** Optional muted second line under the label */
  description?: React.ReactNode;
  /** Hover delay in ms before the tooltip appears (default 500; skipped while warm) */
  delay?: number;
  /** Preferred side; flips to the opposite side when it doesn't fit (default "bottom") */
  placement?: TooltipPlacement;
  /** When true the tooltip is suppressed entirely */
  disabled?: boolean;
  children: React.ReactElement;
}

/** Keybinding chips, VS Code style: each key in its own <kbd>, joined by "+". */
export function KeybindingLabel({ shortcut }: { shortcut: string }) {
  return (
    <span className="app-tooltip-keys">
      {parseShortcut(shortcut).map((chord, ci) => (
        <span key={ci} className="app-tooltip-chord">
          {chord.map((k, ki) => (
            <React.Fragment key={ki}>
              {ki > 0 && <span className="app-tooltip-kbd-sep">+</span>}
              <kbd className="app-tooltip-kbd">{k}</kbd>
            </React.Fragment>
          ))}
        </span>
      ))}
    </span>
  );
}

/**
 * VS Code-style hover for a single trigger element.
 *
 * - Shows after `delay` (500 ms) on hover, or on keyboard focus (focus-visible);
 *   once a tooltip has been shown, neighbours open instantly until it cools down.
 * - Hides on pointer leave, blur, click/pointer-down, scroll, resize, Esc and window blur.
 * - Placed below by default, flipped/shifted to stay inside the viewport.
 * - Never takes focus (portal, `pointer-events: none`); wires `aria-describedby`
 *   on the trigger while visible.
 */
export function Tooltip({
  content, shortcut, description, delay, placement = "bottom", disabled, children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TooltipPos | null>(null);
  const id = useId();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorRef = useRef<Element | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  // Stable identity: the shared runtime uses it to close this tooltip when another opens.
  const hide = useCallback(() => {
    clearTimer();
    if (!openRef.current) return;
    openRef.current = false;
    tooltipRuntime.hidden(hide);
    setOpen(false);
    setPos(null);
  }, []);

  const canShow = (el: Element) =>
    !disabled && !!content && !(el as HTMLButtonElement).disabled && !isMouseDown()
    // Monaco's find widget sits over toolbar buttons — don't flicker under it.
    && !document.querySelector(".monaco-editor .find-widget.visible");

  const show = () => {
    timerRef.current = null;
    const el = anchorRef.current;
    if (!el || !el.isConnected || !canShow(el)) return;
    openRef.current = true;
    tooltipRuntime.shown(hide);
    setOpen(true);
  };

  const schedule = (el: Element) => {
    anchorRef.current = el;
    if (openRef.current || !canShow(el)) return;
    clearTimer();
    const wait = tooltipRuntime.delayFor(delay);
    if (wait === 0) show();
    else timerRef.current = setTimeout(show, wait);
  };

  // ── Position (before paint, so there is no jump) ──────────────────────────
  useLayoutEffect(() => {
    if (!open || !tipRef.current || !anchorRef.current) return;
    const tip = tipRef.current.getBoundingClientRect();
    setPos(placeTooltip(
      anchorRef.current.getBoundingClientRect(),
      { width: tip.width, height: tip.height },
      { width: window.innerWidth, height: window.innerHeight },
      { placement },
    ));
  }, [open, content, shortcut, description, placement]);

  // ── Global dismissal while visible ─────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    const opts = { capture: true, passive: true } as const;
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", hide, opts);
    window.addEventListener("scroll", hide, opts);
    window.addEventListener("resize", hide);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", hide, opts);
      window.removeEventListener("scroll", hide, opts);
      window.removeEventListener("resize", hide);
      window.removeEventListener("blur", hide);
    };
  }, [open, hide]);

  // Suppressed while open (e.g. the trigger's popover just opened) → close now.
  useEffect(() => { if (disabled) hide(); }, [disabled, hide]);

  useEffect(() => () => hide(), [hide]);

  // ── Compose handlers with any the child already has ────────────────────────
  const cp = children.props as Record<string, unknown>;
  const call = (name: string, e: unknown) => (cp[name] as ((e: unknown) => void) | undefined)?.(e);
  const describedBy = [cp["aria-describedby"] as string | undefined, open ? id : undefined]
    .filter(Boolean).join(" ") || undefined;

  const composed: React.HTMLAttributes<HTMLElement> = {
    onMouseEnter(e) { schedule(e.currentTarget); call("onMouseEnter", e); },
    onMouseLeave(e) { hide(); call("onMouseLeave", e); },
    onMouseDown(e)  { hide(); call("onMouseDown", e); },
    onFocus(e)      { if (isFocusVisible(e.currentTarget)) schedule(e.currentTarget); call("onFocus", e); },
    onBlur(e)       { hide(); call("onBlur", e); },
    onKeyDown(e)    { if (e.key === "Escape") hide(); call("onKeyDown", e); },
    "aria-describedby": describedBy,
  };

  return (
    <>
      {React.cloneElement(children, composed)}
      {open && createPortal(
        <div
          ref={tipRef}
          id={id}
          role="tooltip"
          className={`app-tooltip app-tooltip--${pos?.placement ?? placement}`}
          style={{
            position: "fixed",
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? undefined : "hidden",
            pointerEvents: "none",
          }}
        >
          <div className="app-tooltip-row">
            <span className="app-tooltip-label">{content}</span>
            {shortcut && <KeybindingLabel shortcut={shortcut} />}
          </div>
          {description && <div className="app-tooltip-desc">{description}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}
