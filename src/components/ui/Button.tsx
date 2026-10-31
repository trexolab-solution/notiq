import React from "react";
import { Spinner, useLoadingWidth } from "./Loading";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  /**
   * Busy: the spinner replaces `icon` (or is prepended), the label becomes `loadingText`, the button is
   * disabled + aria-busy and keeps its idle width. See the rule in ./Loading.tsx.
   */
  loading?: boolean;
  /** Progressive label while loading ("Syncing…"). Defaults to the normal label. */
  loadingText?: React.ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-[var(--color-primary)] text-[var(--color-bg)] hover:bg-[var(--color-primary-hover)] font-semibold",
  ghost:
    "bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]",
  danger:
    "bg-transparent text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)]",
};

const sizeClasses: Record<Size, string> = {
  sm: "px-2 py-1 text-xs gap-1",
  md: "px-3 py-1.5 text-sm gap-1.5",
};

const SPINNER_SIZE: Record<Size, number> = { sm: 12, md: 14 };

export const Button = React.memo(function Button({
  variant = "ghost",
  size = "md",
  icon,
  loading,
  loadingText,
  children,
  className = "",
  disabled,
  style,
  ...props
}: ButtonProps) {
  const { ref, style: lockedStyle } = useLoadingWidth<HTMLButtonElement>(loading, style);
  const lead = loading ? <Spinner size={SPINNER_SIZE[size]} /> : icon;
  return (
    <button
      ref={ref}
      className={`inline-flex items-center rounded-md transition-colors select-none ${loading ? "justify-center cursor-progress opacity-80" : "cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg)] ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={lockedStyle}
      {...props}
    >
      {lead && <span className="shrink-0 inline-flex">{lead}</span>}
      {loading && loadingText != null ? loadingText : children}
    </button>
  );
});
