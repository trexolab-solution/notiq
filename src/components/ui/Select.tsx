import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown } from "lucide-react";
import { useClickOutside } from "../../hooks/useClickOutside";

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  onChange: (v: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export const Select = React.memo(function Select({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; flipUp: boolean }>({
    top: 0, left: 0, width: 0, flipUp: false,
  });

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedLabel = options.find((o) => o.value === value)?.label ?? placeholder ?? "";

  const openDropdown = useCallback(() => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < 200 && rect.top > spaceBelow;
    setPos({ top: flipUp ? rect.top : rect.bottom + 4, left: rect.left, width: rect.width, flipUp });
    setFocusIdx(options.findIndex((o) => o.value === value));
    setOpen(true);
  }, [disabled, options, value]);

  const closeDropdown = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const selectOption = useCallback(
    (v: string) => {
      onChange(v);
      closeDropdown();
    },
    [onChange, closeDropdown],
  );

  // Close on outside click
  useClickOutside([triggerRef, listRef], closeDropdown, open);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDropdown();
        }
        return;
      }
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setFocusIdx((i) => Math.min(i + 1, options.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setFocusIdx((i) => Math.max(i - 1, 0));
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (focusIdx >= 0 && focusIdx < options.length) selectOption(options[focusIdx].value);
          break;
        case "Escape":
          e.preventDefault();
          closeDropdown();
          break;
      }
    },
    [open, openDropdown, closeDropdown, selectOption, focusIdx, options],
  );

  // Scroll focused item into view
  useEffect(() => {
    if (!open || focusIdx < 0) return;
    listRef.current?.children[focusIdx]?.scrollIntoView({ block: "nearest" });
  }, [open, focusIdx]);

  return (
    <>
      <button
        ref={triggerRef}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        onKeyDown={handleKeyDown}
        className={className}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          minWidth: 180,
          padding: "6px 12px",
          borderRadius: 8,
          fontSize: 13,
          background: "var(--color-bg)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
          outline: "none",
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selectedLabel}
        </span>
        <ChevronDown
          size={12}
          style={{
            flexShrink: 0,
            color: "var(--color-text-muted)",
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.15s",
          }}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              zIndex: 9999,
              left: pos.left,
              top: pos.flipUp ? undefined : pos.top,
              bottom: pos.flipUp ? window.innerHeight - pos.top + 4 : undefined,
              width: pos.width,
              maxHeight: 220,
              overflowY: "auto",
              borderRadius: 8,
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              boxShadow: "0 8px 32px rgba(0,0,0,0.35)",
              padding: 4,
              animation: "select-appear 0.12s ease-out",
            }}
          >
            <style>{`@keyframes select-appear { from { opacity:0; transform:scale(0.96) } to { opacity:1; transform:scale(1) } }`}</style>
            {options.map((o, i) => (
              <div
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectOption(o.value);
                }}
                onMouseEnter={() => setFocusIdx(i)}
                style={{
                  padding: "6px 10px",
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: "pointer",
                  color: o.value === value ? "var(--color-primary)" : "var(--color-text)",
                  fontWeight: o.value === value ? 600 : 400,
                  background:
                    i === focusIdx
                      ? "var(--color-bg-tertiary)"
                      : "transparent",
                  transition: "background 0.08s",
                }}
              >
                {o.label}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
});
