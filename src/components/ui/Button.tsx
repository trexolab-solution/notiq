import React from "react";

type Variant = "primary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
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

export const Button = React.memo(function Button({
  variant = "ghost",
  size = "md",
  icon,
  children,
  className = "",
  ...props
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center rounded-md transition-colors cursor-pointer select-none disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-bg)] ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...props}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </button>
  );
});
