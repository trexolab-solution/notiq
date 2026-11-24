import { Minus, Plus } from "lucide-react";
import type { KeyboardEvent } from "react";

/**
 * A whole-number field that looks and checks the same everywhere: digits only (anything else typed or pasted is
 * dropped), − and + buttons and the arrow keys step it inside `min`..`max`, and a value that is empty or out of range
 * turns the field red (`aria-invalid`) so the caller can say why. `value` is `NaN` while the field is empty.
 * `bare` takes off the border, for a field that sits inside a larger bordered group.
 */
export function NumberField({ value, onChange, label, min = 1, max, step = 1, disabled, bare, invalid, width = 112, className = "" }: {
  value: number;
  onChange: (v: number) => void;
  /** The accessible name (also names the buttons: "Increase …" / "Decrease …"). */
  label: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  bare?: boolean;
  /** Overrides the built-in check (empty, not whole, outside min..max). */
  invalid?: boolean;
  width?: number;
  className?: string;
}) {
  const known = Number.isFinite(value);
  const bad = invalid ?? (!Number.isInteger(value) || value < min || (max != null && value > max));
  const clamp = (n: number) => Math.min(max ?? Number.MAX_SAFE_INTEGER, Math.max(min, n));
  const bump = (dir: 1 | -1) => onChange(known ? clamp(value + dir * step) : min);
  const digits = String(max ?? 9999).length + 1;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") { e.preventDefault(); bump(1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); bump(-1); }
  };

  const edge = "inline-flex h-full w-7 shrink-0 cursor-pointer items-center justify-center text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent";
  const frame = bare
    ? ""
    : `rounded-lg border bg-[var(--color-bg)] ${bad ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus-within:border-[var(--color-primary)]"}`;

  return (
    <div style={{ width }} data-invalid={bad || undefined} className={`inline-flex h-9 items-stretch overflow-hidden ${frame} ${className}`}>
      <button type="button" tabIndex={-1} aria-label={`Decrease ${label}`} disabled={disabled || (known && value <= min)} className={edge} onClick={() => bump(-1)}>
        <Minus size={13} aria-hidden />
      </button>
      <input
        type="text" inputMode="numeric" autoComplete="off" spellCheck={false} aria-label={label} aria-invalid={bad || undefined} disabled={disabled}
        value={known ? String(value) : ""}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          const d = e.target.value.replace(/\D/g, "").slice(0, digits);
          onChange(d === "" ? NaN : Number(d));
        }}
        className={`min-w-0 flex-1 bg-transparent text-center text-sm tabular-nums outline-none disabled:opacity-50 ${bad ? "text-[var(--color-danger)]" : "text-[var(--color-text)]"}`}
      />
      <button type="button" tabIndex={-1} aria-label={`Increase ${label}`} disabled={disabled || (known && max != null && value >= max)} className={edge} onClick={() => bump(1)}>
        <Plus size={13} aria-hidden />
      </button>
    </div>
  );
}
