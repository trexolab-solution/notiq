import { useCallback, useEffect, useRef, useState } from "react";
import type { PanelWidth } from "../lib/panelWidth";

/**
 * Width + drag/keyboard resize for a side panel whose handle is a child of the panel.
 *
 * `edge` is the panel edge the handle sits on: "right" for a panel docked at the left (it grows as the
 * cursor moves right), "left" for a panel docked at the right. `available` is the width the panel's
 * maximum is computed from (the window, or the container it lives in). The user's preferred width is
 * kept as-is and only clamped for display, so shrinking and re-growing the window gives it back.
 * Persisted on release / key press; double-click resets to the default.
 */
export function usePanelResize(model: PanelWidth, { edge, available, label }: {
  edge: "left" | "right";
  available: number;
  label: string;
}) {
  const [preferred, setPreferred] = useState(model.load);
  const [dragging, setDragging] = useState(false);
  const width = model.clamp(preferred, available);
  const widthRef = useRef(width);
  widthRef.current = width;
  const availRef = useRef(available);
  availRef.current = available;
  const dragRef = useRef<{ anchor: number } | null>(null);

  const commit = useCallback((w: number) => {
    const next = model.clamp(w, availRef.current);
    setPreferred(next);
    model.save(next);
  }, [model]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    dragRef.current = { anchor: edge === "right" ? r.left : r.right };
    e.currentTarget.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setDragging(true);
  }, [edge]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    const raw = edge === "right" ? e.clientX - dragRef.current.anchor : dragRef.current.anchor - e.clientX;
    const next = model.clamp(raw, availRef.current);
    widthRef.current = next;
    setPreferred(next);
  }, [edge, model]);

  const endDrag = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    setDragging(false);
    model.save(widthRef.current);
  }, [model]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    const w = widthRef.current;
    // Arrow keys move the handle, so on a left-edge handle ArrowLeft makes the panel wider.
    const grow = edge === "right" ? "ArrowRight" : "ArrowLeft";
    const shrink = edge === "right" ? "ArrowLeft" : "ArrowRight";
    let next: number;
    switch (e.key) {
      case grow: next = w + model.step; break;
      case shrink: next = w - model.step; break;
      case "Home": next = model.min; break;
      case "End": next = model.max(availRef.current); break;
      default: return;
    }
    e.preventDefault();
    commit(next);
  }, [commit, edge, model]);

  const reset = useCallback(() => commit(model.def), [commit, model]);

  useEffect(() => () => {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }, []);

  const handleProps = {
    role: "separator" as const,
    "aria-orientation": "vertical" as const,
    "aria-label": label,
    "aria-valuenow": width,
    "aria-valuemin": model.min,
    "aria-valuemax": model.max(available),
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
