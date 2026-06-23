import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, FileWarning, PenTool, X } from "lucide-react";
import { useEscapeKey } from "../../hooks/useEscapeKey";

interface ConfirmDialogProps {
  title: string;
  message: string;
  /** Additional detail shown below the message (e.g. the note title). */
  detail?: string;
  /** Icon variant to display. Defaults to "warning". */
  icon?: "warning" | "file" | "whiteboard";
  /** Primary safe-action label (defaults to "Confirm") */
  confirmLabel?: string;
  /** Cancel label (defaults to "Cancel") */
  cancelLabel?: string;
  /**
   * Optional destructive secondary action (e.g. "Discard & Close").
   * When provided a third button appears between Cancel and Confirm.
   */
  discardLabel?: string;
  /** Style the confirm button as dangerous */
  danger?: boolean;
  onConfirm?: () => void;
  onCancel: () => void;
  onDiscard?: () => void;
}

const ICONS = {
  warning:    <AlertTriangle size={18} strokeWidth={2} />,
  file:       <FileWarning   size={18} strokeWidth={2} />,
  whiteboard: <PenTool       size={18} strokeWidth={2} />,
};

/** Accessible modal confirmation dialog — replaces native window.confirm(). */
export function ConfirmDialog({
  title, message, detail,
  icon = "warning",
  confirmLabel = "Confirm", cancelLabel = "Cancel", discardLabel,
  danger = false,
  onConfirm, onCancel, onDiscard,
}: ConfirmDialogProps) {
  const firstActionRef = useRef<HTMLButtonElement>(null);

  useEffect(() => { firstActionRef.current?.focus(); }, []);
  useEscapeKey((e) => { e.preventDefault(); onCancel(); });

  return createPortal(
    <>
      <div className="confirm-backdrop" onClick={onCancel} />

      <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="cdlg-title">

        {/* Header row: icon + title + close */}
        <div className="confirm-header">
          <div className={`confirm-icon-wrap confirm-icon-wrap--${icon}`}>
            {ICONS[icon]}
          </div>

          <div className="confirm-header-text">
            <h3 className="confirm-title" id="cdlg-title">{title}</h3>
          </div>

          <button className="confirm-close-btn" onClick={onCancel} aria-label="Cancel">
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="confirm-body">
          <p className="confirm-message">{message}</p>
          {detail && <p className="confirm-detail">{detail}</p>}
        </div>

        {/* Actions */}
        <div className="confirm-actions">
          <button
            ref={!onConfirm && !discardLabel ? firstActionRef : undefined}
            className="confirm-btn confirm-btn--cancel"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>

          {discardLabel && onDiscard && (
            <button
              ref={!onConfirm ? firstActionRef : undefined}
              className="confirm-btn confirm-btn--discard"
              onClick={onDiscard}
            >
              {discardLabel}
            </button>
          )}

          {onConfirm && (
            <button
              ref={firstActionRef}
              className={`confirm-btn confirm-btn--confirm${danger ? " danger" : ""}`}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
