import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./Input";

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

/** Password field with a show/hide (eye) toggle. Visibility resets on unmount. */
export const PasswordInput = React.memo(function PasswordInput({ style, ...props }: Props) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative w-full">
      <Input {...props} type={show ? "text" : "password"} style={{ paddingRight: 32, ...style }} />
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
    </div>
  );
});
