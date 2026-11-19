import { useDroppable } from "@dnd-kit/core";
import type { EntryDrop } from "../useEntryDnd";

/** One part of the path bar: click to go there; an item dragged onto it is moved into that folder. */
export function Crumb({ c, last, onGo }: { c: { name: string; path: string }; last: boolean; onGo: (path: string) => void }) {
  const drop = useDroppable({ id: `crumb:${c.path}`, data: { dest: c.path } satisfies EntryDrop });
  return (
    <button ref={drop.setNodeRef} type="button" onClick={() => onGo(c.path)}
            className={`px-1.5 py-0.5 rounded text-sm cursor-pointer ${drop.isOver ? "bg-[var(--color-primary)]/25 ring-1 ring-[var(--color-primary)] text-[var(--color-text)]"
              : `hover:bg-[var(--color-bg-tertiary)] ${last ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}`}>
      {c.name}
    </button>
  );
}
