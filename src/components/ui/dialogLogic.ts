/**
 * Pure, DOM-free decisions behind the shared `Dialog` primitive: width presets,
 * keyboard routing (Enter / Escape / Tab), the focus-trap wrap rule, which
 * button gets initial focus, and the "which dialog is on top" stack.
 * Kept separate so they can be unit-tested in the Node vitest environment.
 */

export type DialogSize = "sm" | "md" | "lg" | "xl";

/** Width in px for each size preset (the panel is additionally capped at 92vw). */
export const DIALOG_WIDTHS: Readonly<Record<DialogSize, number>> = { sm: 400, md: 480, lg: 640, xl: 760 };

export function dialogWidth(size: DialogSize | number | undefined): number {
  if (typeof size === "number" && Number.isFinite(size) && size > 0) return Math.round(size);
  return DIALOG_WIDTHS[(size as DialogSize) in DIALOG_WIDTHS ? (size as DialogSize) : "md"];
}

// ── Keyboard ────────────────────────────────────────────────────────────────

export interface DialogKeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** IME composition in progress (Enter confirms the composition, not the dialog). */
  isComposing?: boolean;
  /** Lower-case tag name of the focused element (e.g. "button", "input"). */
  targetTag?: string;
  /** `type` attribute of the focused element when it is an <input>. */
  targetType?: string;
  /** The focused element is inside a <form> (native Enter-to-submit applies). */
  targetInForm?: boolean;
  /** The focused element is contenteditable. */
  targetEditable?: boolean;
}

export interface DialogKeyContext {
  /** This dialog is the top-most open dialog. */
  isTop: boolean;
  /** Escape / backdrop / close button may dismiss it. */
  dismissable: boolean;
  /** An Enter-to-confirm handler exists. */
  hasPrimary: boolean;
  /** The primary action is destructive: Enter never fires it from the keyboard shortcut. */
  danger: boolean;
}

export type DialogKeyAction = "cancel" | "primary" | "trap" | null;

/** Elements where Enter already means something (activate, newline, choose). */
const ENTER_OWNERS = new Set(["button", "a", "textarea", "select", "summary"]);
const NON_TEXT_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "file", "image", "color", "range"]);

/**
 * Decides what a keydown means for a dialog:
 * - Escape -> "cancel" (only when dismissable; never the primary action, so a destructive
 *   confirm can't be triggered by Escape).
 * - Enter  -> "primary" only from a plain text field / the panel itself, outside a <form>
 *   (forms submit natively), with no modifiers, and never for danger dialogs.
 * - Tab    -> "trap" (the caller wraps focus inside the panel).
 * Nothing happens unless this dialog is the top-most one.
 */
export function dialogKeyAction(e: DialogKeyInput, ctx: DialogKeyContext): DialogKeyAction {
  if (!ctx.isTop) return null;
  if (e.key === "Escape") return ctx.dismissable ? "cancel" : null;
  if (e.key === "Tab") return e.ctrlKey || e.altKey || e.metaKey ? null : "trap";
  if (e.key !== "Enter") return null;
  if (!ctx.hasPrimary || ctx.danger) return null;
  if (e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.targetInForm || e.targetEditable) return null;
  const tag = (e.targetTag ?? "").toLowerCase();
  if (ENTER_OWNERS.has(tag)) return null;
  if (tag === "input" && NON_TEXT_INPUTS.has((e.targetType ?? "text").toLowerCase())) return null;
  return "primary";
}

// ── Focus ───────────────────────────────────────────────────────────────────

/**
 * Focus-trap wrap rule for Tab inside a panel with `count` tabbable elements, the
 * focused one at `index` (-1 when focus is outside the panel).
 * Returns the index to focus, -1 to focus the panel itself (nothing tabbable), or
 * null to let the browser move focus normally.
 */
export function trapFocusTarget(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return -1;
  if (index < 0 || index >= count) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}

export type DefaultFocus = "primary" | "cancel";

/**
 * Which footer action gets focus when the dialog opens. Danger dialogs default to the
 * safe choice (Cancel) so a stray Enter / Space can't destroy anything.
 */
export function initialFocusChoice(danger: boolean, requested?: DefaultFocus): DefaultFocus {
  if (danger) return "cancel";
  return requested ?? "primary";
}

// ── Stack ───────────────────────────────────────────────────────────────────

/**
 * Tracks open dialogs so only the top-most one reacts to Escape / Enter / Tab.
 * Ids are allocated in render order (parent before child, earlier before later),
 * so the highest mounted id is the top-most dialog even though React mounts
 * effects child-first.
 */
export function createDialogStack() {
  let seq = 0;
  const open = new Set<number>();
  return {
    nextId: () => ++seq,
    add: (id: number) => { open.add(id); },
    remove: (id: number) => { open.delete(id); },
    top: (): number | null => (open.size ? Math.max(...open) : null),
    isTop: (id: number) => open.size > 0 && Math.max(...open) === id,
    size: () => open.size,
  };
}

export type DialogStack = ReturnType<typeof createDialogStack>;
