import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  /** Main label shown in the tooltip */
  content: React.ReactNode;
  /** Optional keyboard shortcut shown as a kbd pill */
  shortcut?: string;
  /** Hover delay in ms before the tooltip appears (default 550) */
  delay?: number;
  /** When true the tooltip is suppressed entirely */
  disabled?: boolean;
  children: React.ReactElement;
}

// ── Module-level shared state ────────────────────────────────────────────────

// Fast-follow: once a tooltip has been shown, the next tooltip in the same
// "session" appears instantly so scanning a toolbar doesn't require waiting
// the full delay on every button.
let lastHideTime = 0;
const FAST_FOLLOW_WINDOW = 400; // ms — if re-entering within this window, skip delay

// Skip tooltip while any mouse button is held (prevents flash during click/drag)
let isMouseDown = false;
if (typeof document !== "undefined") {
  document.addEventListener("mousedown", () => { isMouseDown = true; },  { capture: true, passive: true });
  document.addEventListener("mouseup",   () => { isMouseDown = false; }, { capture: true, passive: true });
}

// ── Component ────────────────────────────────────────────────────────────────

export function Tooltip({ content, shortcut, delay = 550, disabled, children }: TooltipProps) {
  const [visible, setVisible]   = useState(false);
  const [pos, setPos]           = useState({ x: 0, y: 0, above: false });
  const timerRef                = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipRef              = useRef<HTMLDivElement>(null);
  const wasVisibleRef           = useRef(false); // true while this instance's tooltip is shown

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  const open = useCallback(
    (el: Element) => {
      if (disabled || !content) return;
      // Auto-detect disabled form controls — no tooltip on an inactive button
      if ((el as HTMLButtonElement).disabled) return;
      // Don't show while a mouse button is held (click or drag in progress)
      if (isMouseDown) return;
      // Don't show when Monaco find widget is open — prevents flickering near the X button
      if (document.querySelector(".monaco-editor .find-widget.visible")) return;

      clearTimer();

      // Fast-follow: skip the delay if we're quickly moving between tooltipped elements
      const elapsed     = Date.now() - lastHideTime;
      const actualDelay = elapsed < FAST_FOLLOW_WINDOW ? 0 : delay;

      timerRef.current = setTimeout(() => {
        // Re-check conditions at the moment of showing
        if (isMouseDown) return;
        if ((el as HTMLButtonElement).disabled) return;

        const r     = el.getBoundingClientRect();
        const above = r.bottom + 52 > window.innerHeight;
        setPos({ x: r.left + r.width / 2, y: above ? r.top - 10 : r.bottom + 8, above });
        wasVisibleRef.current = true;
        setVisible(true);
      }, actualDelay);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [disabled, content, delay],
  );

  const close = useCallback(() => {
    clearTimer();
    // Only update the fast-follow timer when this instance's tooltip was actually shown
    if (wasVisibleRef.current) {
      lastHideTime = Date.now();
      wasVisibleRef.current = false;
    }
    setVisible(false);
  }, []);

  // ── Viewport edge clamping ─────────────────────────────────────────────────
  // Runs synchronously before paint so there is no visible position jump.
  useLayoutEffect(() => {
    if (!visible || !tooltipRef.current) return;
    const MARGIN = 8;
    const rect   = tooltipRef.current.getBoundingClientRect();
    if (rect.right > window.innerWidth - MARGIN) {
      setPos((p) => ({ ...p, x: p.x - (rect.right - window.innerWidth + MARGIN) }));
    } else if (rect.left < MARGIN) {
      setPos((p) => ({ ...p, x: p.x + (MARGIN - rect.left) }));
    }
  }, [visible]);

  // ── Hide on scroll (tooltip becomes stale when content scrolls away) ───────
  useEffect(() => {
    if (!visible) return;
    const hide = () => { wasVisibleRef.current = false; setVisible(false); };
    window.addEventListener("scroll", hide, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", hide, { capture: true });
  }, [visible]);

  // Cleanup on unmount
  useEffect(() => () => clearTimer(), []);

  // ── Compose event handlers with any existing ones on the child ────────────
  const cp = children.props as Record<string, unknown>;
  type ME = React.MouseEvent; type FE = React.FocusEvent;
  const composed: React.HTMLAttributes<HTMLElement> = {
    onMouseEnter(e: ME) { open(e.currentTarget as Element); (cp.onMouseEnter as ((e: ME) => void) | undefined)?.(e); },
    onMouseLeave(e: ME) { close();                          (cp.onMouseLeave as ((e: ME) => void) | undefined)?.(e); },
    onFocus(e: FE)      { open(e.currentTarget as Element); (cp.onFocus      as ((e: FE) => void) | undefined)?.(e); },
    onBlur(e: FE)       { close();                          (cp.onBlur       as ((e: FE) => void) | undefined)?.(e); },
  };

  return (
    <>
      {React.cloneElement(children, composed)}
      {visible && createPortal(
        <div
          ref={tooltipRef}
          className={`app-tooltip${pos.above ? " app-tooltip--above" : ""}`}
          style={{
            position:      "fixed",
            left:          pos.x,
            top:           pos.y,
            transform:     pos.above ? "translate(-50%, -100%)" : "translateX(-50%)",
            pointerEvents: "none",
          }}
        >
          <span className="app-tooltip-label">{content}</span>
          {shortcut && <kbd className="app-tooltip-kbd">{shortcut}</kbd>}
        </div>,
        document.body,
      )}
    </>
  );
}
