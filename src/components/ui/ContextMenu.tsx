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
}

/**
 * The one right-click / dropdown menu used across the app. Stays on screen near
 * the anchor, is keyboard navigable (arrows, Home/End, Enter, Escape), and closes
 * on an outside click, another right-click, scroll, resize or window blur.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
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
    menuRef.current?.focus({ preventScroll: true });
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
    itemRefs.current[idx]?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Handled here (the menu has focus) so an Escape doesn't also close a dialog behind it.
    e.stopPropagation();
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
      onKeyDown={onKeyDown}
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
            className={`context-menu-item${item.danger ? " danger" : ""}`}
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
