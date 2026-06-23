import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

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

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [focusIdx, setFocusIdx] = useState(-1);

  // Collect refs to focusable items for keyboard navigation
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Measure actual menu size after render and adjust to stay within viewport
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const left = x + rect.width > window.innerWidth - pad
      ? Math.max(pad, x - rect.width)
      : Math.max(pad, x);
    const top = y + rect.height > window.innerHeight - pad
      ? Math.max(pad, y - rect.height)
      : Math.max(pad, y);
    setPos({ left, top });
  }, [x, y]);

  // Get indices of actionable (non-separator, non-label) items
  const actionableIndices = items
    .map((item, i) => (item.type === "item" ? i : -1))
    .filter((i) => i >= 0);

  useEffect(() => {
    const el = menuRef.current;
    if (el) el.focus();

    const onMouseDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocusIdx((prev) => {
          const currentPos = actionableIndices.indexOf(prev);
          let nextPos: number;
          if (e.key === "ArrowDown") {
            nextPos = currentPos < 0 ? 0 : (currentPos + 1) % actionableIndices.length;
          } else {
            nextPos = currentPos <= 0 ? actionableIndices.length - 1 : currentPos - 1;
          }
          const nextIdx = actionableIndices[nextPos];
          itemRefs.current[nextIdx]?.focus();
          return nextIdx;
        });
        return;
      }

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (focusIdx >= 0) {
          const item = items[focusIdx];
          if (item?.type === "item" && !item.disabled) {
            item.onClick?.();
            onClose();
          }
        }
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, focusIdx, items, actionableIndices]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: pos.left, top: pos.top }}
      tabIndex={-1}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
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
            ref={(el) => { itemRefs.current[i] = el; }}
            className={`context-menu-item${item.danger ? " danger" : ""}`}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            tabIndex={-1}
            onClick={() => {
              if (!item.disabled) {
                item.onClick?.();
                onClose();
              }
            }}
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
