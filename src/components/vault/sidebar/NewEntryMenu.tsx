import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { NEW_ENTRY_OPTIONS, type NewEntryKind } from "../../../lib/vaultCreate";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import { EntryIcon } from "./EntryIcon";

/** Header "+" dropdown: every entry type. Creates in the selected folder. */
export function NewEntryMenu({ targetLabel, onPick }: { targetLabel: string; onPick: (k: NewEntryKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Fixed position from the trigger, clamped to the window, so the menu can't be cut off at the left/right edge.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current) { setPos(null); return; }
    const r = trigger.current.getBoundingClientRect();
    const W = 232, MARGIN = 8;
    setPos({ left: Math.max(MARGIN, Math.min(r.left, window.innerWidth - W - MARGIN)), top: r.bottom + 4 });
  }, [open]);

  useClickOutside(wrap, () => setOpen(false), open);
  useEscapeKey(() => { setOpen(false); trigger.current?.focus(); }, open);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  const move = (dir: 1 | -1) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + dir + items.length) % items.length]?.focus();
  };

  return (
    <div className="relative" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="vt-icon-btn"
        title="New secret…"
        aria-label="New secret"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Plus size={15} />
      </button>
      {open && (
        <div
          ref={menu}
          role="menu"
          className="vt-menu"
          style={pos ? { position: "fixed", left: pos.left, top: pos.top, right: "auto" } : { visibility: "hidden" }}
          aria-label="New secret"
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
          }}
        >
          <div className="px-2 pt-1 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] truncate">
            New in {targetLabel}
          </div>
          {NEW_ENTRY_OPTIONS.map((o) => (
            <button
              key={o.kind}
              role="menuitem"
              type="button"
              className="vt-menu-item"
              onClick={() => { setOpen(false); onPick(o.kind); }}
            >
              <EntryIcon kind={o.kind} />
              <span className="min-w-0">
                <span className="block text-xs font-medium">{o.label}</span>
                <span className="block text-[11px] text-[var(--color-text-muted)]">{o.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
