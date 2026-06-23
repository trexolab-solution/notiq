import { useRef } from "react";
import type { ReactNode, CSSProperties } from "react";
import { useEscapeKey } from "../../hooks/useEscapeKey";

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
 * Shared modal shell: a centered, blurred backdrop with Escape-to-close and
 * click-outside-to-close. Replaces the identical overlay `<div>` + Escape
 * `useEffect` that every modal used to hand-roll. Render the dialog panel as
 * `children`; this component owns only the backdrop and dismissal behaviour.
 */
export function Modal({
  onClose,
  children,
  overlayStyle,
  zClassName = "z-50",
  dismissable = true,
}: ModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  useEscapeKey(onClose, dismissable);

  return (
    <div
      ref={overlayRef}
      className={`fixed inset-0 ${zClassName} flex items-center justify-center`}
      style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(6px)", ...overlayStyle }}
      onMouseDown={(e) => {
        if (dismissable && e.target === overlayRef.current) onClose();
      }}
    >
      {children}
    </div>
  );
}
