import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Ellipsis, Plus } from "lucide-react";
import { Button } from "../ui/Button";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
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
           className={"h-6 -ml-1.5 px-1.5 min-w-[9rem] max-w-full [field-sizing:content] rounded text-xs " +
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

const ADD_BLOCK =
  "w-full justify-center min-h-8 border border-dashed border-[var(--color-border)] !text-[var(--color-text)] " +
  "hover:border-[var(--color-primary)] hover:!text-[var(--color-primary)] " +
  "hover:!bg-[color-mix(in_srgb,var(--color-primary)_6%,transparent)]";

/** Polite live region. `announce` replaces its text; repeating the same message still gets read. */
export function useAnnouncer() {
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const announce = useCallback((text: string) => {
    setMsg("");
    if (timer.current) clearTimeout(timer.current);
    // A tick later, so an identical message is still a DOM change screen readers pick up.
    timer.current = setTimeout(() => setMsg(text), 30);
  }, []);
  const region = <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">{msg}</div>;
  return { announce, region };
}

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

/** Keeps the latest value in a ref, for Undo closures that run after later edits. */
export function useLatest<T>(v: T) {
  const r = useRef(v);
  r.current = v;
  return r;
}

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
