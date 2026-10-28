import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { NEW_ENTRY_OPTIONS, type NewEntryKind } from "../../../lib/vaultCreate";
import { useClickOutside } from "../../../hooks/useClickOutside";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import { EntryIcon } from "./EntryIcon";

const KIND_ICON: Record<NewEntryKind, "note" | "login" | "ssh" | "secret"> = {
  note: "note", login: "login", ssh: "ssh", secret: "secret",
};

/** Header "+" dropdown: the four entry types. Creates in the selected folder. */
export function NewEntryMenu({ targetLabel, onPick }: { targetLabel: string; onPick: (k: NewEntryKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

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
              <EntryIcon kind={KIND_ICON[o.kind]} />
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
