import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Ellipsis, GripVertical, Plus } from "lucide-react";
import {
  closestCenter, DndContext, PointerSensor, useSensor, useSensors,
  type DragCancelEvent, type DragEndEvent, type DragOverEvent, type DragStartEvent, type Modifier, type UniqueIdentifier,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "../ui/Button";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { useReducedMotion } from "../ui/Loading";
import { Tooltip } from "../ui/Tooltip";
import { toast } from "../../lib/toast";

/**
 * Shared building blocks for the vault forms' repeated-row editors (other websites, custom fields,
 * recovery codes, passkeys): one icon-button size, one Add control, focus that lands somewhere sensible
 * after add / remove / move, polite screen-reader announcements and an Undo toast for removals.
 */

/** Hit target for every row action: 28×28 px (≥ 24 px minimum), icon centred, pressed feedback. */
export const rowButtonClass =
  "!p-0 h-7 w-7 justify-center shrink-0 active:scale-95 active:bg-[var(--color-bg-tertiary)] aria-pressed:text-[var(--color-primary)]";
const ROW_BTN_DANGER =
  "hover:!text-[var(--color-danger)] hover:!bg-[var(--color-danger)]/10 focus-visible:!ring-[var(--color-danger)]/50";

interface RowIconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** Accessible name, including the row's identity ("Remove website example.com"). */
  label: string;
  /** Tooltip text; defaults to `label`. */
  tooltip?: React.ReactNode;
  icon: React.ReactNode;
  /** Destructive action: muted until hover / focus, then danger-coloured. */
  danger?: boolean;
  /** Toggle buttons: rendered as aria-pressed. */
  pressed?: boolean;
}

/** Icon-only row action with a tooltip; every list row uses this so sizes and states match. */
export function RowIconButton({ label, tooltip, icon, danger, pressed, className = "", ...rest }: RowIconButtonProps) {
  return (
    <Tooltip content={tooltip ?? label}>
      <Button size="sm" aria-label={label} aria-pressed={pressed} icon={icon}
              className={`${rowButtonClass} ${danger ? ROW_BTN_DANGER : ""} ${className}`} {...rest} />
    </Tooltip>
  );
}

/** Group of actions at the end of a list item: fixed gap so every row lines up. */
export function RowActions({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex items-center gap-0.5 shrink-0 ${className}`}>{children}</div>;
}

/**
 * Empty slot the size of a {@link RowIconButton}. Rows whose action column has an optional action (reveal
 * only on hidden values) render this in its place, so inputs end at the same x in every row.
 */
export function RowIconSpacer() {
  return <span aria-hidden className="h-7 w-7 shrink-0" />;
}

/** The outlined, divided box a list's rows sit in ("Also used on", custom fields): one light frame, no card per row. */
export const listBoxClass =
  "flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]";
/** Row hover inside {@link listBoxClass}: a faint tint, light enough that inputs in the row keep their edge. */
export const listRowHoverClass =
  "transition-colors hover:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_55%,transparent)] " +
  "focus-within:bg-[color-mix(in_srgb,var(--color-bg-tertiary)_55%,transparent)]";

/**
 * "⋯" button that opens the app's {@link ContextMenu} as a dropdown under it, for a row's secondary actions.
 * A menu button in the ARIA sense: `aria-haspopup` / `aria-expanded`; Enter, Space or ↓ open it with the
 * first enabled item focused; disabled items are skipped; Escape, Tab or an outside click return focus here.
 */
export function RowMenuButton({ label, menuLabel, items, tooltip = "More actions", className = "", ...rest }:
  Omit<RowIconButtonProps, "icon" | "onClick" | "pressed" | "danger" | "tooltip"> & {
    /** Accessible name of the menu itself; defaults to `label`. */
    menuLabel?: string;
    items: ContextMenuItem[];
    tooltip?: string;
  }) {
  const btn = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  // The outside press that closes the menu can land on this button: its click must not re-open it.
  const closingByPress = useRef(false);

  const open = (el: HTMLButtonElement) => {
    btn.current = el;
    const r = el.getBoundingClientRect();
    setAt({ x: r.right, y: r.bottom + 4 });
  };
  const close = () => {
    setAt(null);
    // Back to the button, unless the user has already moved on to another control.
    const a = document.activeElement;
    if (!a || a === document.body || a.closest('[role="menu"]')) btn.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <RowIconButton label={label} tooltip={tooltip} icon={<Ellipsis size={14} />} aria-haspopup="menu"
                     aria-expanded={!!at}
                     className={`aria-expanded:bg-[var(--color-bg-tertiary)] aria-expanded:text-[var(--color-text)] ${className}`}
                     {...rest}
                     onMouseDown={() => { closingByPress.current = !!at; }}
                     onClick={(e) => {
                       if (closingByPress.current) { closingByPress.current = false; return; }
                       open(e.currentTarget);
                     }}
                     onKeyDown={(e) => { if (e.key === "ArrowDown" && !at) { e.preventDefault(); open(e.currentTarget); } }} />
      {at && <ContextMenu x={at.x} y={at.y} align="end" autoFocusFirst label={menuLabel ?? label} items={items} onClose={close} />}
    </>
  );
}

/**
 * Text input that reads as a field label: small muted text at rest, an input outline on hover and a full
 * input look on focus. For user-named rows (a custom field's name), so they match the built-in labels.
 * While empty it keeps a dashed outline, so it is plainly something to fill in.
 */
export const InlineLabelInput = React.memo(function InlineLabelInput(
  { className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement>,
) {
  return (
    <input type="text" {...props}
           className={"h-6 -ml-1.5 px-1.5 min-w-[3rem] max-w-full [field-sizing:content] rounded text-xs " +
             "bg-transparent border border-transparent text-[var(--color-text-muted)] " +
             "placeholder:text-[var(--color-text-muted)] placeholder:opacity-70 " +
             "placeholder-shown:border-dashed placeholder-shown:border-[var(--color-border)] " +
             "outline-none transition-colors cursor-text hover:border-[var(--color-border)] hover:text-[var(--color-text)] " +
             "focus:border-solid focus:border-[var(--color-primary)] focus:bg-[var(--color-bg-tertiary)] focus:text-[var(--color-text)] " +
             `focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 ${className}`} />
  );
});

/**
 * "+ Add …" control. At the limit it stays focusable (aria-disabled) so its tooltip can explain why,
 * and clicks do nothing. Marked `data-list-add` so {@link useListFocus} can return focus to it.
 */
export function AddRowButton({ children, onAdd, atLimit, limitText, tooltip, block }: {
  children: React.ReactNode; onAdd: () => void; atLimit?: boolean; limitText?: string; tooltip?: string;
  /** Full-width dashed button under a list ("+ Add website", "+ Add field"). */
  block?: boolean;
}) {
  const hintId = useId();
  return (
    <>
      <Tooltip content={atLimit ? limitText : tooltip}>
        <Button size="sm" icon={<Plus size={12} />} data-list-add="" aria-disabled={atLimit || undefined}
                aria-describedby={atLimit && limitText ? hintId : undefined}
                className={`min-h-7 ${block ? ADD_BLOCK : ""} ${atLimit ? "!opacity-40 !cursor-not-allowed hover:!bg-transparent hover:!border-[var(--color-border)] hover:!text-[var(--color-text)]" : ""}`}
                onClick={() => { if (!atLimit) onAdd(); }}>
          {children}
        </Button>
      </Tooltip>
      {atLimit && limitText && <span id={hintId} className="sr-only">{limitText}</span>}
    </>
  );
}

/** Moved to hooks/useAnnouncer so non-vault UI (the Stepper) can use it; re-exported for the editors. */
export { useAnnouncer } from "../../hooks/useAnnouncer";

const ADD_BLOCK =
  "w-full justify-center min-h-8 border border-dashed border-[var(--color-border)] !text-[var(--color-text)] " +
  "hover:border-[var(--color-primary)] hover:!text-[var(--color-primary)] " +
  "hover:!bg-[color-mix(in_srgb,var(--color-primary)_6%,transparent)]";


type FocusTarget = { index: number; selector?: string } | "add";

/**
 * Moves focus after the list changes. Put `rootRef` on the editor's wrapper: rows are its `[data-list-row]`
 * descendants; inside a row the target is `selector` or the first `[data-row-focus]`. An index past the end
 * falls back to the last row, and an empty list falls back to the `[data-list-add]` button.
 */
export function useListFocus<T extends HTMLElement = HTMLDivElement>() {
  const rootRef = useRef<T | null>(null);
  const pending = useRef<FocusTarget | null>(null);

  useLayoutEffect(() => {
    const t = pending.current;
    const root = rootRef.current;
    if (!t || !root) return;
    pending.current = null;
    const toAdd = () => root.querySelector<HTMLElement>("[data-list-add]")?.focus();
    if (t === "add") { toAdd(); return; }
    const rows = [...root.querySelectorAll<HTMLElement>("[data-list-row]")];
    if (!rows.length) { toAdd(); return; }
    const row = rows[Math.min(t.index, rows.length - 1)];
    const target = (t.selector && row.querySelector<HTMLElement>(t.selector))
      || row.querySelector<HTMLElement>("[data-row-focus]")
      || row.querySelector<HTMLElement>("button:not([disabled]), input");
    target?.focus();
  });

  /** Call alongside the state change; focus moves once the new list has rendered. */
  const focusAfter = useCallback((t: FocusTarget) => { pending.current = t; }, []);
  return { rootRef, focusAfter };
}

/**
 * "Removed X · Undo" toast. `restore` runs on Undo; the toast is withdrawn when the editor unmounts
 * (another tab), so Undo can never write into an entry that is no longer on screen.
 */
export function useUndoToast() {
  const ids = useRef(new Set<string>());
  useEffect(() => {
    const live = ids.current;
    return () => { for (const id of live) toast.dismiss(id); };
  }, []);
  return useCallback((message: string, restore: () => void) => {
    const id = `vault-undo-${Math.random().toString(36).slice(2)}`;
    ids.current.add(id);
    toast.info(message, {
      id, source: "Vault", duration: 6000,
      actions: [{ label: "Undo", primary: true, onClick: () => { ids.current.delete(id); toast.dismiss(id); restore(); } }],
    });
  }, []);
}

export { useLatest } from "../../hooks/useLatest";

/** Inline error for a field: spread `inputProps` onto the input, add `errorClass`, render `message` below it. */
export function useFieldError(error: string | null | undefined) {
  const id = useId();
  return {
    inputProps: { "aria-invalid": error ? true : undefined, "aria-describedby": error ? id : undefined },
    errorClass: error ? "!border-[var(--color-danger)]" : "",
    message: error ? (
      <p id={id} className="flex items-center gap-1 text-xs mt-1 text-[var(--color-danger)]">
        <span aria-hidden className="font-bold">!</span>{error}
      </p>
    ) : null,
  };
}

/** Insert `item` back at `index` (clamped) — the inverse of removing it. */
export function reinsert<T>(list: T[], index: number, item: T): T[] {
  const i = Math.max(0, Math.min(index, list.length));
  return [...list.slice(0, i), item, ...list.slice(i)];
}

/**
 * `list` with the item at `from` taken out and put back at `to`; the items between shift by one.
 * Out-of-range or no-op moves return the list unchanged (same reference).
 */
export function moveTo<T>(list: T[], from: number, to: number): T[] {
  const n = list.length;
  if (from === to || from < 0 || to < 0 || from >= n || to >= n) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

// ── Sortable rows ──────────────────────────────────────────────────────────────────────────────────────
// Pointer dragging reuses @dnd-kit (already behind tab reordering): its PointerSensor runs on pointer
// events, not HTML5 drag-and-drop, which the webview's native file drop would intercept on Windows, and it
// auto-scrolls the form near its edges. Keyboard reordering is our own, so it can speak through the list's
// useAnnouncer region and keep focus on the handle while the rows move.

const lockToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });
const silent = () => undefined;
/** dnd-kit's own live region stays quiet: the list announces through its useAnnouncer region instead. */
const QUIET = { onDragStart: silent, onDragMove: silent, onDragOver: silent, onDragEnd: silent, onDragCancel: silent };
const SORT_INSTRUCTIONS =
  "Drag to reorder, or press Space to pick up, the arrow keys to move, Space to drop and Escape to cancel.";

/**
 * Reorderable list state: pointer drag (via {@link SortableRows}) and keyboard pick / move / drop / cancel on
 * each row's {@link RowDragHandle}. Nothing is written until the drop, which calls `onReorder` once, so a
 * whole move is one change. Render rows in `order` (indices into the list; it differs from 0..n-1 only while
 * a keyboard move is in progress) and key them by `ids`, which must stay the same while sorting.
 */
export function useSortableList({ ids, nameOf, onReorder, announce, focusHandle }: {
  ids: string[];
  /** Row name for announcements ("Customer ID"). */
  nameOf: (index: number) => string;
  /** Commit: move the item at `from` to `to`. Called once per drop, never for a no-op. */
  onReorder: (from: number, to: number) => void;
  announce: (text: string) => void;
  /** Focus the handle of the row now shown at `position` (after the next render). */
  focusHandle: (position: number) => void;
}) {
  const [kb, setKb] = useState<{ from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const instructionsId = useId();
  const n = ids.length;
  const at = (p: number) => `position ${p + 1} of ${n}`;
  const order = kb ? moveTo(ids.map((_, i) => i), kb.from, kb.to) : ids.map((_, i) => i);

  const drop = (from: number, to: number) => {
    if (to !== from) onReorder(from, to);
    focusHandle(to);
    announce(`Dropped ${nameOf(from)} at ${at(to)}`);
  };
  const cancel = (from: number) => {
    focusHandle(from);
    announce(`Reorder cancelled. ${nameOf(from)} is back at ${at(from)}`);
  };

  const handleKeyDown = (index: number) => (e: React.KeyboardEvent) => {
    const pick = e.key === " " || e.key === "Enter";
    if (!kb) {
      if (!pick || dragging != null) return;
      e.preventDefault();
      setKb({ from: index, to: index });
      announce(`Picked up ${nameOf(index)}, ${at(index)}`);
      return;
    }
    if (kb.from !== index) return;
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const to = Math.max(0, Math.min(n - 1, kb.to + (e.key === "ArrowUp" ? -1 : 1)));
      setKb({ from: index, to });
      focusHandle(to);
      announce(`${nameOf(index)}, ${at(to)}`);
    } else if (pick) {
      e.preventDefault();
      setKb(null);
      drop(kb.from, kb.to);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't also close a dialog behind the form
      setKb(null);
      cancel(kb.from);
    } else if (e.key === "Tab") {
      setKb(null); // leaving the handle puts the row back
      announce(`Reorder cancelled. ${nameOf(kb.from)} is back at ${at(kb.from)}`);
    }
  };

  const indexOf = (id: UniqueIdentifier) => ids.indexOf(String(id));
  // The slot last announced during a pointer drag: dnd-kit also reports "over" for the row's own slot.
  const overSlot = useRef<UniqueIdentifier | null>(null);
  const dnd = {
    onDragStart: ({ active }: DragStartEvent) => {
      const i = indexOf(active.id);
      overSlot.current = active.id;
      setDragging(i);
      announce(`Picked up ${nameOf(i)}, ${at(i)}`);
    },
    onDragOver: ({ active, over }: DragOverEvent) => {
      if (!over || over.id === overSlot.current) return;
      overSlot.current = over.id;
      announce(`${nameOf(indexOf(active.id))}, ${at(indexOf(over.id))}`);
    },
    onDragEnd: ({ active, over }: DragEndEvent) => {
      const from = indexOf(active.id);
      setDragging(null);
      drop(from, over ? indexOf(over.id) : from);
    },
    onDragCancel: ({ active }: DragCancelEvent) => {
      setDragging(null);
      cancel(indexOf(active.id));
    },
  };

  return {
    order,
    /** Display order as ids, for the SortableContext. */
    items: order.map((i) => ids[i]),
    /** Index of the row lifted by keyboard or pointer, or null. */
    lifted: kb?.from ?? dragging,
    handleKeyDown,
    instructionsId,
    instructions: <span id={instructionsId} className="sr-only">{SORT_INSTRUCTIONS}</span>,
    dnd,
  };
}

/** The drag context for a {@link useSortableList} list: wrap its `<ul>` (rows use {@link useSortableRow}). */
export function SortableRows({ sort, children }: { sort: ReturnType<typeof useSortableList>; children: React.ReactNode }) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[lockToVerticalAxis]}
                accessibility={{ announcements: QUIET, restoreFocus: false }} {...sort.dnd}>
      <SortableContext items={sort.items} strategy={verticalListSortingStrategy}>{children}</SortableContext>
    </DndContext>
  );
}

const SORT_TRANSITION = { duration: 160, easing: "cubic-bezier(0.2, 0, 0, 1)" };

/** One row of a {@link SortableRows} list: spread `rowProps` on the row and `handleProps` on its {@link RowDragHandle}. */
export function useSortableRow(id: string) {
  const reduced = useReducedMotion();
  const { setNodeRef, setActivatorNodeRef, listeners, transform, transition, isDragging } = useSortable({
    id,
    transition: reduced ? null : SORT_TRANSITION,
    // Also slide rows into place when a keyboard move or a removal changes their position.
    animateLayoutChanges: () => !reduced,
  });
  return {
    isDragging,
    rowProps: {
      ref: setNodeRef,
      style: { transform: CSS.Translate.toString(transform), transition: reduced ? undefined : transition },
    },
    handleProps: { ref: setActivatorNodeRef, ...listeners },
  };
}

/** Classes for a lifted row (pointer drag or keyboard pick): raised above its neighbours. */
export const liftedRowClass =
  "relative z-10 !bg-[var(--color-bg-secondary)] shadow-lg ring-1 ring-[var(--color-primary)]/60 rounded-md";

/**
 * Grip at the start of a sortable row: drag it with the pointer, or focus it and use Space / arrows / Space
 * (Escape cancels). Faint at rest, clear on row hover or focus — the row needs the `group` class.
 */
export function RowDragHandle({ label, lifted, describedBy, onKeyDown, handleProps }: {
  label: string; lifted: boolean; describedBy: string;
  onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => void;
  handleProps: ReturnType<typeof useSortableRow>["handleProps"];
}) {
  const { ref, ...listeners } = handleProps;
  return (
    <Tooltip content="Drag to reorder">
      <button type="button" ref={ref} data-row-handle="" aria-label={label} aria-describedby={describedBy}
              aria-pressed={lifted} onKeyDown={onKeyDown} {...listeners}
              className={"inline-flex items-center justify-center h-7 w-6 shrink-0 rounded-md touch-none select-none " +
                "cursor-grab active:cursor-grabbing text-[var(--color-text-muted)] opacity-40 transition-opacity " +
                "group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] " +
                "aria-pressed:opacity-100 aria-pressed:text-[var(--color-primary)] " +
                "focus-visible:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50"}>
        <GripVertical size={14} aria-hidden />
      </button>
    </Tooltip>
  );
}
