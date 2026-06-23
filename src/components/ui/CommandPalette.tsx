import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface Command {
  id: string;
  label: string;
  /** Short group/section label, e.g. "Tabs", "Actions", "Theme", "AI". */
  group: string;
  /** Extra searchable text (e.g. file path) not shown as the title. */
  hint?: string;
  icon?: React.ReactNode;
  /** Right-aligned hint (shortcut or status). */
  trailing?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Filter by simple case-insensitive substring over label + group + hint.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      c.label.toLowerCase().includes(q) ||
      c.group.toLowerCase().includes(q) ||
      (c.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [commands, query]);

  // Keep the active index in range when the filtered list changes.
  useEffect(() => { setActive(0); }, [query]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  // Scroll the active row into view.
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    // Defer so the overlay unmounts before the action (e.g. focus changes) runs.
    setTimeout(() => cmd.run(), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(filtered.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); run(filtered[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  // Render with group headers (only when the group changes).
  let lastGroup = "";

  return createPortal(
    <div
      className="cmdk-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="cmdk" role="dialog" aria-label="Command palette">
        <input
          ref={inputRef}
          className="cmdk__input"
          placeholder="Search tabs, actions, themes…"
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="cmdk__list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmdk__empty">No matching commands</div>
          ) : (
            filtered.map((c, i) => {
              const showHeader = c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <React.Fragment key={c.id}>
                  {showHeader && <div className="cmdk__group">{c.group}</div>}
                  <button
                    type="button"
                    data-idx={i}
                    className={`cmdk__item${i === active ? " is-active" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => run(c)}
                  >
                    {c.icon && <span className="cmdk__icon">{c.icon}</span>}
                    <span className="cmdk__label">{c.label}</span>
                    {c.hint && <span className="cmdk__hint">{c.hint}</span>}
                    {c.trailing && <span className="cmdk__trailing">{c.trailing}</span>}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
