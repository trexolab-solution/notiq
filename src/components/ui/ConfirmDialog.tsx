import { useState } from "react";
import type { ReactNode } from "react";
import { FileWarning, PenTool } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogCheckbox, DialogFooter, type DialogIconKind, type DialogIconProp } from "./Dialog";

interface ConfirmDialogProps {
  title: string;
  message: string;
  /** Secondary, muted text shown below the message (e.g. the note title or a path). */
  detail?: ReactNode;
  /** Icon variant. Defaults to "warning". */
  icon?: "file" | "whiteboard" | DialogIconKind;
  /** Primary action label (defaults to "Confirm") */
  confirmLabel?: string;
  /** Cancel label (defaults to "Cancel") */
  cancelLabel?: string;
  /**
   * Optional destructive secondary action (e.g. "Discard & Close").
   * When provided a third button appears, left of Cancel.
   */
  discardLabel?: string;
  /** Style the confirm button as dangerous; Cancel then gets the initial focus. */
  danger?: boolean;
  /** Optional "Don't ask again"-style row; its state is passed to `onConfirm`. */
  checkbox?: { label: ReactNode; defaultChecked?: boolean; onChange?: (checked: boolean) => void };
  onConfirm?: (checked: boolean) => void;
  onCancel: () => void;
  onDiscard?: () => void;
  /** Backdrop z-index class. Defaults to above every app overlay except toasts. */
  zClassName?: string;
}

const ICON: Record<"file" | "whiteboard", { node: ReactNode; tone: "primary" | "accent" }> = {
  file: { node: <FileWarning size={16} />, tone: "primary" },
  whiteboard: { node: <PenTool size={16} />, tone: "accent" },
};

/** Accessible modal confirmation dialog — replaces native window.confirm(). */
export function ConfirmDialog({
  title, message, detail,
  icon = "warning",
  confirmLabel = "Confirm", cancelLabel = "Cancel", discardLabel,
  danger = false,
  checkbox,
  onConfirm, onCancel, onDiscard,
  zClassName = "z-[96000]",
}: ConfirmDialogProps) {
  const [checked, setChecked] = useState(!!checkbox?.defaultChecked);
  const custom = icon === "file" || icon === "whiteboard" ? ICON[icon] : null;
  const iconProp: DialogIconProp = custom ? custom.node : icon;
  const showDiscard = !!(discardLabel && onDiscard);

  return (
    <Dialog
      role="alertdialog"
      size="sm"
      title={title}
      icon={iconProp}
      iconTone={custom?.tone}
      danger={danger}
      // Without a confirm action the discard button (or Cancel) is the focus target.
      defaultFocus={onConfirm ? "primary" : "cancel"}
      onPrimary={onConfirm ? () => onConfirm(checked) : undefined}
      onClose={onCancel}
      zClassName={zClassName}
    >
      <DialogBody message={message} detail={detail}>
        {checkbox && (
          <DialogCheckbox
            checked={checked}
            label={checkbox.label}
            onChange={(v) => { setChecked(v); checkbox.onChange?.(v); }}
          />
        )}
      </DialogBody>
      <DialogFooter
        start={showDiscard ? (
          <DialogButton variant="ghost" className="dlg-btn--discard" cancel={!onConfirm} onClick={onDiscard}>
            {discardLabel}
          </DialogButton>
        ) : undefined}
      >
        <DialogButton cancel={!(showDiscard && !onConfirm)} onClick={onCancel}>{cancelLabel}</DialogButton>
        {onConfirm && (
          <DialogButton variant={danger ? "danger" : "primary"} onClick={() => onConfirm(checked)}>
            {confirmLabel}
          </DialogButton>
        )}
      </DialogFooter>
    </Dialog>
  );
}
