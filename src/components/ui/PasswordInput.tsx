import React, { useState } from "react";
import { Eye, EyeOff, ArrowBigUp } from "lucide-react";
import { Input } from "./Input";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/** Password field with a show/hide (eye) toggle and a Caps Lock warning. Visibility resets on unmount. */
export const PasswordInput = React.memo(function PasswordInput({ style, onKeyDown, onKeyUp, onBlur, ...props }: Props) {
  const [show, setShow] = useState(false);
  const [caps, setCaps] = useState(false);
  const readCaps = (e: React.KeyboardEvent<HTMLInputElement>) => setCaps(e.getModifierState?.("CapsLock") ?? false);
  return (
    <div className="relative w-full">
      <Input {...props} type={show ? "text" : "password"} style={{ paddingRight: 32, ...style }}
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
        <p role="status" className="mt-1 flex items-center gap-1 text-xs text-[var(--color-warning)]">
          <ArrowBigUp size={13} aria-hidden /> Caps Lock is on
        </p>
      )}
    </div>
  );
});
