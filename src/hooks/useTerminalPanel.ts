import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useAppStore } from "../store";
import type { TerminalPanelHandle } from "../components/terminal/TerminalPanel";
import type { TerminalLayout } from "../types";

const TERMINAL_MIN_H = 100;
const TERMINAL_MIN_W = 200;
// Reserve space for title bar, sidebar, editor tab bar, and status bar so the
// editor never disappears entirely (VS Code-style).
const TERMINAL_TOP_RESERVE  = 120;
// Minimum editor width preserved when terminal is on the right.
const TERMINAL_LEFT_RESERVE = 320;
const TERMINAL_DEF_H = 240;
const TERMINAL_DEF_W = 360;

export interface UseTerminalPanelResult {
  /** Whether the terminal panel is currently visible. */
  isOpen:  boolean;
  /** True after the panel has been opened at least once (kept mounted afterwards). */
  mounted: boolean;
  /** Height in px (used in horizontal layout). */
  height:  number;
  /** Width in px (used in vertical layout). */
  width:   number;
  /** Current panel layout: "horizontal" (bottom) or "vertical" (right). */
  layout:  TerminalLayout;
  /** Imperative handle into the TerminalPanel component (fit/focus/etc.). */
  panelRef: RefObject<TerminalPanelHandle>;

  /** Toggle visibility (mounts on first open). */
  toggle:        () => void;
  /** Force-close the panel. */
  close:         () => void;
  /** Flip horizontal ↔ vertical layout. */
  toggleLayout:  () => void;
  /** Mouse-down handler for the resize handle (layout-aware drag). */
  onResizeDrag:  (e: React.MouseEvent) => void;
}

/**
 * Owns all state, drag-resize, window-clamp, and keyboard-shortcut logic for
 * the terminal panel. App.tsx renders the panel and threads the returned
 * fields into JSX; nothing else lives in App.tsx.
 *
 * Keyboard shortcuts wired up:
 *   Ctrl+`         → toggle terminal
 *   Ctrl+Shift+`   → open and add a new session/tab
 *   Ctrl+J         → focus terminal (open if closed)
 *   Ctrl+Shift+\   → toggle horizontal/vertical layout
 *   Ctrl+Shift+W   → close active pane (only when terminal has focus)
 */
export function useTerminalPanel(): UseTerminalPanelResult {
  const [isOpen,  setIsOpen]  = useState(false);
  const [mounted, setMounted] = useState(false);
  const [height,  setHeight]  = useState(TERMINAL_DEF_H);
  const [width,   setWidth]   = useState(TERMINAL_DEF_W);

  const layout         = useAppStore((s) => s.terminalLayout);
  const setLayoutStore = useAppStore((s) => s.setTerminalLayout);

  const panelRef = useRef<TerminalPanelHandle>(null);

  // Stable refs — drag closures read these to avoid stale state.
  const heightRef = useRef(height);
  const widthRef  = useRef(width);
  const layoutRef = useRef(layout);
  heightRef.current = height;
  widthRef.current  = width;
  layoutRef.current = layout;

  // Cleanup ref so we can detach drag listeners on unmount mid-drag.
  const dragCleanupRef = useRef<(() => void) | null>(null);

  // ── Actions ────────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      if (!prev) setMounted(true);
      return !prev;
    });
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  const toggleLayout = useCallback(() => {
    setLayoutStore(layoutRef.current === "horizontal" ? "vertical" : "horizontal");
  }, [setLayoutStore]);

  // ── Drag-resize handle ────────────────────────────────────────────────
  const onResizeDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startLayout = layoutRef.current;
    const startCoord  = startLayout === "horizontal" ? e.clientY : e.clientX;
    const startSize   = startLayout === "horizontal" ? heightRef.current : widthRef.current;

    const onMove = (ev: MouseEvent) => {
      if (layoutRef.current === "horizontal") {
        const maxH = Math.max(TERMINAL_MIN_H, window.innerHeight - TERMINAL_TOP_RESERVE);
        const next = Math.min(maxH, Math.max(TERMINAL_MIN_H, startSize + (startCoord - ev.clientY)));
        setHeight(next);
      } else {
        const maxW = Math.max(TERMINAL_MIN_W, window.innerWidth - TERMINAL_LEFT_RESERVE);
        const next = Math.min(maxW, Math.max(TERMINAL_MIN_W, startSize + (startCoord - ev.clientX)));
        setWidth(next);
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
      dragCleanupRef.current = null;
      panelRef.current?.fit();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
    dragCleanupRef.current = onUp;
  }, []);

  // ── Effects ────────────────────────────────────────────────────────────

  // Cleanup mid-drag listeners on unmount.
  useEffect(() => () => { dragCleanupRef.current?.(); }, []);

  // Fit + focus xterm when the panel becomes visible.
  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => {
      panelRef.current?.fit();
      panelRef.current?.focus();
    });
  }, [isOpen]);

  // Re-fit xterm after layout switches so it reflows for the new orientation.
  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => panelRef.current?.fit());
  }, [layout, isOpen]);

  // Clamp size when the window shrinks so the editor stays visible.
  useEffect(() => {
    const onResize = () => {
      const maxH = Math.max(TERMINAL_MIN_H, window.innerHeight - TERMINAL_TOP_RESERVE);
      const maxW = Math.max(TERMINAL_MIN_W, window.innerWidth  - TERMINAL_LEFT_RESERVE);
      setHeight((cur) => (cur > maxH ? maxH : cur));
      setWidth((cur)  => (cur > maxW ? maxW : cur));
      panelRef.current?.fit();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Backtick shortcuts
      if (e.key === "`") {
        if (e.ctrlKey && e.shiftKey) {
          e.preventDefault();
          setMounted(true);
          setIsOpen(true);
          requestAnimationFrame(() => panelRef.current?.newSession());
        } else if (e.ctrlKey) {
          e.preventDefault();
          toggle();
        }
        return;
      }

      // Ctrl+J → focus terminal (open it first if needed)
      if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === "j" || e.key === "J")) {
        e.preventDefault();
        if (!isOpen) {
          setMounted(true);
          setIsOpen(true);
          requestAnimationFrame(() => panelRef.current?.focus());
        } else {
          panelRef.current?.focus();
        }
        return;
      }

      // Ctrl+Shift+\ → toggle layout. Some keyboard layouts emit "|" for Shift+\.
      if (e.ctrlKey && e.shiftKey && (e.key === "\\" || e.key === "|")) {
        e.preventDefault();
        toggleLayout();
        return;
      }

      // Ctrl+Shift+W → close active pane (only when terminal has focus)
      if (
        e.ctrlKey && e.shiftKey && !e.altKey
        && (e.key === "w" || e.key === "W")
        && isOpen
      ) {
        const inTerminal = (e.target as HTMLElement | null)?.closest?.(".terminal-panel");
        if (inTerminal) {
          e.preventDefault();
          panelRef.current?.closeActivePane();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, toggle, toggleLayout]);

  return {
    isOpen, mounted, height, width, layout,
    panelRef,
    toggle, close, toggleLayout, onResizeDrag,
  };
}
