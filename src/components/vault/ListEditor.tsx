import React, { useCallback, useEffect, useId, useLayoutEffect, useRef } from "react";
import { Plus } from "lucide-react";
import { Button } from "../ui/Button";
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
 * "+ Add …" control. At the limit it stays focusable (aria-disabled) so its tooltip can explain why,
 * and clicks do nothing. Marked `data-list-add` so {@link useListFocus} can return focus to it.
 */
export function AddRowButton({ children, onAdd, atLimit, limitText, tooltip }: {
  children: React.ReactNode; onAdd: () => void; atLimit?: boolean; limitText?: string; tooltip?: string;
}) {
  const hintId = useId();
  return (
    <>
      <Tooltip content={atLimit ? limitText : tooltip}>
        <Button size="sm" icon={<Plus size={12} />} data-list-add="" aria-disabled={atLimit || undefined}
                aria-describedby={atLimit && limitText ? hintId : undefined}
                className={`min-h-7 ${atLimit ? "!opacity-40 !cursor-not-allowed hover:!bg-transparent" : ""}`}
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

/** Swap the item at `from` with its neighbour at `to`; out-of-range moves return the list unchanged. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}
