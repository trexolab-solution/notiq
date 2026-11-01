import { useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface RadioCardOption<T extends string> {
  value: T;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Small pill after the title ("Recommended"). */
  badge?: ReactNode;
  /** Destructive choice: red accents when selected. */
  danger?: boolean;
}

/**
 * Large selectable cards that behave as one radio group: a single tab stop (the selected card), arrow
 * keys move the selection and focus, Home/End jump to the ends.
 */
export function RadioCards<T extends string>({ value, onChange, options, label, disabled }: {
  value: T;
  onChange: (v: T) => void;
  options: readonly RadioCardOption<T>[];
  label: string;
  disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const i = Math.max(0, options.findIndex((o) => o.value === value));
    const n = options.length;
    const to = e.key === "ArrowDown" || e.key === "ArrowRight" ? (i + 1) % n
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (i - 1 + n) % n
        : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(options[to].value);
    root.current?.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  };

  return (
    <div ref={root} role="radiogroup" aria-label={label} aria-disabled={disabled || undefined}
         className="flex flex-col gap-2" onKeyDown={onKeyDown}>
      {options.map((o) => {
        const on = o.value === value;
        const accent = o.danger ? "var(--color-danger)" : "var(--color-primary)";
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1}
                  disabled={disabled} onClick={() => onChange(o.value)} data-value={o.value}
                  style={on ? { borderColor: accent, boxShadow: `inset 0 0 0 1px ${accent}` } : undefined}
                  className="flex items-start gap-3 w-full text-left rounded-lg border p-3 cursor-pointer transition-colors border-[var(--color-border)] bg-[var(--color-bg)] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50">
            <span aria-hidden className="mt-0.5 shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full border"
                  style={{ borderColor: on ? accent : "var(--color-border)" }}>
              {on && <span className="w-2 h-2 rounded-full" style={{ background: accent }} />}
            </span>
            {o.icon && <span aria-hidden className="mt-px shrink-0 inline-flex" style={{ color: on ? accent : "var(--color-text-muted)" }}>{o.icon}</span>}
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-2 text-sm font-semibold" style={on && o.danger ? { color: accent } : undefined}>
                {o.title}
                {o.badge && (
                  <span className="rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide bg-[var(--color-primary)]/15 text-[var(--color-primary)]">
                    {o.badge}
                  </span>
                )}
              </span>
              {o.description && <span className="block mt-0.5 text-xs text-[var(--color-text-muted)]">{o.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
