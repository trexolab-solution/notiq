import { useRef } from "react";
import type { ReactNode, CSSProperties } from "react";
import { useDialogBehaviour } from "./useDialogBehaviour";

interface ModalProps {
  /** Called on Escape or a click on the backdrop (outside the dialog surface). */
  onClose: () => void;
  /** The dialog surface — Modal only owns the backdrop/centering, not the panel. */
  children: ReactNode;
  /** Merged into the backdrop style (e.g. a stronger blur or higher opacity). */
  overlayStyle?: CSSProperties;
  /** Tailwind z-index class for the backdrop. Defaults to `z-50`. */
  zClassName?: string;
  /** When false, Escape and backdrop clicks no longer dismiss. Defaults to true. */
  dismissable?: boolean;
}

/**
 * Bare modal shell: the shared dimmed backdrop with Escape / click-outside to close,
 * a Tab focus trap and focus restore. Render your own panel as `children`.
 * New dialogs should use `Dialog` (./Dialog), which also draws the panel, title bar
 * and footer; Modal stays for surfaces that bring a fully custom panel.
 */
export function Modal({
  onClose,
  children,
  overlayStyle,
  zClassName = "z-50",
  dismissable = true,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useDialogBehaviour(overlayRef, { onClose, dismissable });

  return (
    <div
      ref={overlayRef}
      className={`dlg-scrim fixed inset-0 ${zClassName}`}
      style={overlayStyle}
      onMouseDown={(e) => {
        if (dismissable && e.target === overlayRef.current) onClose();
      }}
    >
      {children}
    </div>
  );
}
