import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { clampMenuPosition, nextFocusIndex } from "../../lib/contextMenu/position";

export interface ContextMenuItem {
  type: "item" | "separator" | "label";
  label?: string;
  icon?: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /**
   * Leave keyboard focus where it is (a text field the menu acts on) instead of
   * moving it into the menu — moving it would blur the field, and blur-to-commit
   * inputs like the tab rename box would close under the menu.
   */
  keepFocus?: boolean;
}

/**
 * The one right-click / dropdown menu used across the app. Stays on screen near
 * the anchor, is keyboard navigable (arrows, Home/End, Enter, Escape), and closes
 * on an outside click, another right-click, scroll, resize or window blur.
 */
export function ContextMenu({ x, y, items, onClose, keepFocus = false }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [focusIdx, setFocusIdx] = useState(-1);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Measure after render and keep the whole menu inside the viewport.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(clampMenuPosition(x, y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [x, y, items.length]);

  useClickOutside(menuRef, () => onClose());

  useEffect(() => {
    if (!keepFocus) menuRef.current?.focus({ preventScroll: true });
    const close = () => onCloseRef.current();
    // Scrolling anything but the menu itself would leave it floating off its target.
    const onScroll = (e: Event) => {
      if (!(e.target instanceof Node && menuRef.current?.contains(e.target))) close();
    };
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [keepFocus]);

  // Capture-phase so menu keys never reach the editor / field / dialog underneath,
  // whether or not the menu holds focus.
  const onKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKeyDownRef.current(e);
    window.addEventListener("keydown", h, true);
    return () => window.removeEventListener("keydown", h, true);
  }, []);

  const enabled = items.map((it) => it.type === "item" && !it.disabled);

  const run = (item: ContextMenuItem | undefined) => {
    if (item?.type !== "item" || item.disabled) return;
    item.onClick?.();
    onClose();
  };

  const moveFocus = (idx: number) => {
    if (idx < 0) return;
    setFocusIdx(idx);
    if (!keepFocus) itemRefs.current[idx]?.focus({ preventScroll: true });
  };

  onKeyDownRef.current = (e: KeyboardEvent) => {
    const nav = ["Escape", "Tab", "ArrowDown", "ArrowUp", "Home", "End", "Enter", " "];
    if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
    if (!nav.includes(e.key)) {
      if (keepFocus) onClose(); // typing goes on in the field
      return;
    }
    e.stopPropagation(); // an Escape must not also close a dialog behind the menu
    switch (e.key) {
      case "Escape": e.preventDefault(); onClose(); return;
      case "Tab":    e.preventDefault(); onClose(); return;
      case "ArrowDown": e.preventDefault(); moveFocus(nextFocusIndex(enabled, focusIdx, 1)); return;
      case "ArrowUp":   e.preventDefault(); moveFocus(nextFocusIndex(enabled, focusIdx, -1)); return;
      case "Home":      e.preventDefault(); moveFocus(nextFocusIndex(enabled, -1, 1)); return;
      case "End":       e.preventDefault(); moveFocus(nextFocusIndex(enabled, -1, -1)); return;
      case "Enter":
      case " ":
        e.preventDefault();
        run(items[focusIdx]);
    }
  };

  if (items.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      tabIndex={-1}
      role="menu"
      // Clicking an item must not pull focus out of the field it acts on.
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {items.map((item, i) => {
        const key = `${item.type}-${item.label ?? ""}-${i}`;
        if (item.type === "separator") {
          return <div key={key} className="context-menu-separator" role="separator" />;
        }
        if (item.type === "label") {
          return <div key={key} className="context-menu-label" role="presentation">{item.label}</div>;
        }
        return (
          <button
            key={key}
            type="button"
            ref={(el) => { itemRefs.current[i] = el; }}
            className={`context-menu-item${item.danger ? " danger" : ""}${i === focusIdx ? " is-active" : ""}`}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            tabIndex={-1}
            onMouseEnter={() => { if (!item.disabled) moveFocus(i); }}
            onClick={() => run(item)}
          >
            {item.icon && <span className="item-icon">{item.icon}</span>}
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.shortcut && <span className="item-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>
  );
}
