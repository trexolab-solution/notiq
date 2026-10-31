import { useCallback, useEffect, useRef, useState } from "react";
import {
  VAULT_PANEL_DEFAULT, VAULT_PANEL_MIN, VAULT_PANEL_STEP,
  clampVaultPanelWidth, loadVaultPanelWidth, maxVaultPanelWidth, saveVaultPanelWidth,
} from "../lib/vaultPanelWidth";

/**
 * Vault sidebar width + right-edge drag resize (the panel sits at the left, so the width follows the cursor's x
 * relative to the panel's left edge). Persisted on release; re-clamped when the window shrinks.
 */
export function useVaultPanelResize() {
  const [width, setWidth] = useState(() => loadVaultPanelWidth(window.innerWidth));
  const [dragging, setDragging] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragRef = useRef<{ left: number } | null>(null);

  const commit = useCallback((w: number) => {
    const next = clampVaultPanelWidth(w, window.innerWidth);
    setWidth(next);
    saveVaultPanelWidth(next);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    dragRef.current = { left: panel.getBoundingClientRect().left };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    const next = clampVaultPanelWidth(e.clientX - dragRef.current.left, window.innerWidth);
    widthRef.current = next;
    setWidth(next);
  }, []);

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragging(false);
    saveVaultPanelWidth(widthRef.current);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const w = widthRef.current;
    let next: number;
    switch (e.key) {
      case "ArrowLeft": next = w - VAULT_PANEL_STEP; break;
      case "ArrowRight": next = w + VAULT_PANEL_STEP; break;
      case "Home": next = VAULT_PANEL_MIN; break;
      case "End": next = maxVaultPanelWidth(window.innerWidth); break;
      default: return;
    }
    e.preventDefault();
    commit(next);
  }, [commit]);

  const reset = useCallback(() => commit(VAULT_PANEL_DEFAULT), [commit]);

  useEffect(() => {
    const onResize = () => setWidth((w) => clampVaultPanelWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const handleProps = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": "Resize vault sidebar",
    "aria-valuenow": width,
    "aria-valuemin": VAULT_PANEL_MIN,
    "aria-valuemax": maxVaultPanelWidth(window.innerWidth),
    tabIndex: 0,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    onLostPointerCapture: endDrag,
    onKeyDown,
    onDoubleClick: reset,
  };

  return { width, dragging, handleProps };
}
