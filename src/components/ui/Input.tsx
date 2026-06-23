import React from "react";

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.memo(function Input({ className = "", ...props }: InputProps) {
  return (
    <input
      className={`bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] rounded-md px-2 py-1 text-sm outline-none focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40 transition-colors w-full ${className}`}
      {...props}
    />
  );
});
