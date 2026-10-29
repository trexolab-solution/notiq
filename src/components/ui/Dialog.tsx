import { useId, useMemo, useRef } from "react";
import type { CSSProperties, FormEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { DialogContext } from "./dialogContext";
import { DialogHeader, type DialogIconProp, type DialogTone } from "./DialogParts";
import { dialogWidth, type DefaultFocus, type DialogSize } from "./dialogLogic";
import { useDialogBehaviour } from "./useDialogBehaviour";

export * from "./DialogParts";
export type { DialogSize, DefaultFocus } from "./dialogLogic";

export interface DialogProps {
  /** Escape, a backdrop click and the × button call this (only while `dismissable`). */
  onClose: () => void;
  /** When false, Escape / backdrop / × no longer dismiss. Defaults to true. */
  dismissable?: boolean;
  /** Width preset (sm 400 / md 480 / lg 640 / xl 760) or a px number. Capped at 92vw. */
  size?: DialogSize | number;

  /** Title bar text. Omit for a header-less dialog (then pass `ariaLabel`). */
  title?: ReactNode;
  /** Leading icon in the title bar: a kind (info, question, warning, danger, success, shield) or any icon. */
  icon?: DialogIconProp;
  iconTone?: DialogTone;
  /** Extra title-bar controls, placed before the × button. */
  headerActions?: ReactNode;
  /** Show the × button. Defaults to `dismissable`. */
  showClose?: boolean;

  /** `alertdialog` for confirmations that interrupt; `dialog` otherwise. */
  role?: "dialog" | "alertdialog";
  /** Accessible name when there is no `title`. */
  ariaLabel?: string;
  /** Override the auto aria-describedby (the DialogBody `message`). */
  ariaDescribedBy?: string;

  /** Enter (from a non-button, non-form field) runs this. Ignored for `danger` dialogs. */
  onPrimary?: () => void;
  /** Destructive dialog: Cancel gets initial focus and Enter never fires the primary action. */
  danger?: boolean;
  /** Which footer action is focused on open when no field is auto-focused. Defaults to "primary". */
  defaultFocus?: DefaultFocus;
  initialFocusRef?: RefObject<HTMLElement | null>;

  /** Render the panel as a <form> (native Enter-to-submit). */
  onSubmit?: (e: FormEvent<HTMLFormElement>) => void;
  /** Tailwind z-index class for the backdrop. Defaults to `z-50`. */
  zClassName?: string;
  className?: string;
  style?: CSSProperties;
  /** Extra attributes for testing hooks. */
  "data-testid"?: string;
  children?: ReactNode;
}

/**
 * The shared VS Code-style modal dialog: dimmed backdrop, centred panel with an
 * optional title bar, scrollable body and right-aligned footer.
 * Handles Escape (top-most dialog only, never the primary action), Enter-to-primary,
 * a real focus trap, initial focus (Cancel for danger dialogs) and focus restore.
 *
 * Compose with `DialogBody`, `DialogFooter` and `DialogButton`:
 *
 *   <Dialog title="Delete note?" icon="warning" danger onClose={cancel}>
 *     <DialogBody message="…" detail="…" />
 *     <DialogFooter>
 *       <DialogButton cancel onClick={cancel}>Cancel</DialogButton>
 *       <DialogButton variant="danger" onClick={ok}>Delete</DialogButton>
 *     </DialogFooter>
 *   </Dialog>
 */
export function Dialog({
  onClose,
  dismissable = true,
  size = "md",
  title,
  icon,
  iconTone,
  headerActions,
  showClose,
  role = "dialog",
  ariaLabel,
  ariaDescribedBy,
  onPrimary,
  danger = false,
  defaultFocus,
  initialFocusRef,
  onSubmit,
  zClassName = "z-50",
  className = "",
  style,
  children,
  ...rest
}: DialogProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const titleId = `${uid}-title`;
  const descriptionId = `${uid}-desc`;

  useDialogBehaviour(panelRef, { onClose, dismissable, onPrimary, danger, autoFocus: true, defaultFocus, initialFocusRef });

  const ctx = useMemo(() => ({ titleId, descriptionId, onClose, dismissable }), [titleId, descriptionId, onClose, dismissable]);

  const panelProps = {
    ref: panelRef as never,
    className: `dlg-panel ${className}`,
    style: { "--dlg-w": `${dialogWidth(size)}px`, ...style } as CSSProperties,
    role,
    "aria-modal": true,
    "aria-labelledby": title != null ? titleId : undefined,
    "aria-label": title == null ? ariaLabel : undefined,
    "aria-describedby": ariaDescribedBy ?? descriptionId,
    tabIndex: -1,
    "data-testid": rest["data-testid"],
  };
  const content = (
    <>
      {title != null && (
        <DialogHeader title={title} icon={icon} iconTone={iconTone} actions={headerActions} showClose={showClose} />
      )}
      {children}
    </>
  );

  return createPortal(
    <DialogContext.Provider value={ctx}>
      <div
        ref={scrimRef}
        className={`dlg-scrim fixed inset-0 ${zClassName}`}
        onMouseDown={(e) => { if (dismissable && e.target === scrimRef.current) onClose(); }}
      >
        {onSubmit
          ? <form {...panelProps} onSubmit={onSubmit}>{content}</form>
          : <div {...panelProps}>{content}</div>}
      </div>
    </DialogContext.Provider>,
    document.body,
  );
}
