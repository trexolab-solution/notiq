import React, { useState } from "react";
import { Eye, EyeOff, ArrowBigUp } from "lucide-react";
import { Input } from "./Input";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/**
 * Password field with a show/hide (eye) toggle and a Caps Lock indicator. The indicator is an icon inside the
 * field (room for it is always reserved), so the layout around the field never moves when Caps Lock changes.
 * Visibility resets on unmount.
 */
export const PasswordInput = React.memo(function PasswordInput({ style, onKeyDown, onKeyUp, onBlur, ...props }: Props) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const readCaps = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  return (
    <div className="relative w-full">
      <Input {...props} type={show ? "text" : "password"} style={{ paddingRight: 54, ...style }}
             onKeyDown={(e) => { readCaps(e); onKeyDown?.(e); }}
             onKeyUp={(e) => { readCaps(e); onKeyUp?.(e); }}
             onBlur={(e) => { setCaps(false); onBlur?.(e); }} />
      <button
        type="button"
        tabIndex={-1}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setShow((s) => !s)}
        className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
      >
        {show ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
      {caps && (
        <span title="Caps Lock is on" className="absolute right-7 top-1/2 -translate-y-1/2 inline-flex text-[var(--color-warning)] pointer-events-none">
          <ArrowBigUp size={15} aria-hidden />
        </span>
      )}
      <span role="status" className="sr-only">{caps ? "Caps Lock is on" : ""}</span>
    </div>
  );
});
