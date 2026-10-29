import React from "react";
import type { ReactNode } from "react";
import { CircleCheck, CircleQuestionMark, Info, OctagonAlert, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useDialogContext } from "./dialogContext";

// ── Icon ────────────────────────────────────────────────────────────────────

export type DialogIconKind = "info" | "question" | "warning" | "danger" | "success" | "shield";
export type DialogTone = "primary" | "accent" | "warning" | "danger" | "success" | "muted";

const KIND_GLYPH: Record<DialogIconKind, (p: { size: number }) => ReactNode> = {
  info: (p) => <Info {...p} />,
  question: (p) => <CircleQuestionMark {...p} />,
  warning: (p) => <TriangleAlert {...p} />,
  danger: (p) => <OctagonAlert {...p} />,
  success: (p) => <CircleCheck {...p} />,
  shield: (p) => <ShieldCheck {...p} />,
};
const KIND_TONE: Record<DialogIconKind, DialogTone> = {
  info: "accent", question: "primary", warning: "warning", danger: "danger", success: "success", shield: "primary",
};

export const isDialogIconKind = (v: unknown): v is DialogIconKind => typeof v === "string" && v in KIND_GLYPH;

/** A small tinted glyph tile. Pass a `kind`, or any icon as children plus a `tone`. */
export function DialogIcon({ kind, tone, children }: { kind?: DialogIconKind; tone?: DialogTone; children?: ReactNode }) {
  const t = tone ?? (kind ? KIND_TONE[kind] : "primary");
  return (
    <span className={`dlg-icon dlg-icon--${t}`} aria-hidden>
      {children ?? (kind ? KIND_GLYPH[kind]({ size: 16 }) : null)}
    </span>
  );
}

/** Accepts either an icon kind or a ready-made icon node. */
export type DialogIconProp = DialogIconKind | ReactNode;

const renderIcon = (icon: DialogIconProp | undefined, tone?: DialogTone) =>
  icon == null || icon === false ? null : isDialogIconKind(icon)
    ? <DialogIcon kind={icon} tone={tone} />
    : <DialogIcon tone={tone}>{icon}</DialogIcon>;

// ── Header ──────────────────────────────────────────────────────────────────

export interface DialogHeaderProps {
  title: ReactNode;
  icon?: DialogIconProp;
  iconTone?: DialogTone;
  /** Extra controls before the close button (e.g. a "Re-check" button). */
  actions?: ReactNode;
  /** Show the × button. Defaults to the dialog being dismissable. */
  showClose?: boolean;
}

/** Title bar: [icon] Title ……… [actions] [×]. The title is the dialog's accessible name. */
export function DialogHeader({ title, icon, iconTone, actions, showClose }: DialogHeaderProps) {
  const ctx = useDialogContext();
  const close = showClose ?? !!ctx?.dismissable;
  return (
    <div className="dlg-header">
      {renderIcon(icon, iconTone)}
      <h2 className="dlg-title" id={ctx?.titleId}>{title}</h2>
      {actions && <div className="dlg-header-actions">{actions}</div>}
      {close && ctx && (
        <button type="button" className="dlg-close" aria-label="Close" onClick={ctx.onClose}>
          <X size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

// ── Body ────────────────────────────────────────────────────────────────────

export interface DialogBodyProps {
  /** Primary text; it becomes the dialog's accessible description. */
  message?: ReactNode;
  /** Secondary, muted text under the message. */
  detail?: ReactNode;
  /** Shown beside the message (used when the dialog has no title bar). */
  icon?: DialogIconProp;
  iconTone?: DialogTone;
  /** Remove the inner padding (for split panes / edge-to-edge lists). */
  flush?: boolean;
  /** Lay children out as a flex column that fills the body (for panes that scroll themselves). */
  fill?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Scrollable content area between header and footer. */
export function DialogBody({ message, detail, icon, iconTone, flush, fill, className = "", children }: DialogBodyProps) {
  const ctx = useDialogContext();
  const text = (message != null || detail != null) && (
    <div className="dlg-text">
      {message != null && <p className="dlg-message" id={ctx?.descriptionId}>{message}</p>}
      {detail != null && <p className="dlg-detail">{detail}</p>}
    </div>
  );
  return (
    <div
      data-dialog-body=""
      className={`dlg-body${flush ? " dlg-body--flush" : ""}${fill ? " dlg-body--fill" : ""} ${className}`}
    >
      {text && (icon ? <div className="dlg-lead">{renderIcon(icon, iconTone)}{text}</div> : text)}
      {children}
    </div>
  );
}

/** Muted explanatory paragraph inside a body (the shared "description" style). */
export function DialogText({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return <p id={id} className={`dlg-detail dlg-detail--block ${className}`}>{children}</p>;
}

// ── Checkbox row ────────────────────────────────────────────────────────────

export interface DialogCheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  /** Muted second line under the label. */
  hint?: ReactNode;
}

/** "Don't ask again"-style row. */
export function DialogCheckbox({ checked, onChange, label, hint }: DialogCheckboxProps) {
  return (
    <label className="dlg-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="dlg-check-hint">{hint}</span>}
      </span>
    </label>
  );
}

// ── Footer + buttons ────────────────────────────────────────────────────────

export interface DialogFooterProps {
  /** Left-aligned content (a link, a toggle, a secondary tool). */
  start?: ReactNode;
  /** Draw a hairline above the footer (for dialogs whose body scrolls). */
  divided?: boolean;
  children?: ReactNode;
}

/** Action row: optional start content, then right-aligned buttons (secondary first, primary last). */
export function DialogFooter({ start, divided, children }: DialogFooterProps) {
  return (
    <div className={`dlg-footer${divided ? " dlg-footer--divided" : ""}`}>
      {start && <div className="dlg-footer-start">{start}</div>}
      <div className="dlg-footer-actions">{children}</div>
    </div>
  );
}

export type DialogButtonVariant = "primary" | "secondary" | "danger" | "ghost";

export interface DialogButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: DialogButtonVariant;
  icon?: ReactNode;
  /** Marks the dialog's cancel action (gets initial focus in danger dialogs). */
  cancel?: boolean;
}

/**
 * Footer button. `primary` / `danger` buttons are the default action (initial focus,
 * unless the dialog is dangerous); `cancel` marks the safe choice.
 */
export const DialogButton = React.forwardRef<HTMLButtonElement, DialogButtonProps>(function DialogButton(
  { variant = "secondary", icon, cancel, className = "", type = "button", children, ...props }, ref,
) {
  const isDefault = variant === "primary" || variant === "danger";
  return (
    <button
      ref={ref}
      type={type}
      className={`dlg-btn dlg-btn--${variant} ${className}`}
      data-dialog-default={isDefault ? "" : undefined}
      data-dialog-cancel={cancel ? "" : undefined}
      {...props}
    >
      {icon && <span className="dlg-btn-icon" aria-hidden>{icon}</span>}
      {children}
    </button>
  );
});
