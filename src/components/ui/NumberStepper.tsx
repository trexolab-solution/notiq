import React, { useCallback, useRef } from "react";
import { Minus, Plus } from "lucide-react";

interface NumberStepperProps {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  formatValue?: (v: number) => string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export const NumberStepper = React.memo(function NumberStepper({
  value,
  onChange,
  min = -Infinity,
  max = Infinity,
  step = 1,
  formatValue,
  disabled,
  className,
  "aria-label": ariaLabel,
}: NumberStepperProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clamp = useCallback(
    (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step)),
    [min, max, step],
  );

  const stopRepeat = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
  }, []);

  const startRepeat = useCallback(
    (dir: 1 | -1) => {
      if (disabled) return;
      const next = clamp(value + dir * step);
      onChange(next);

      // Hold-to-repeat: 400ms delay then 80ms interval
      timerRef.current = setTimeout(() => {
        let current = next;
        intervalRef.current = setInterval(() => {
          current = clamp(current + dir * step);
          onChange(current);
        }, 80);
      }, 400);

      const cleanup = () => {
        stopRepeat();
        document.removeEventListener("mouseup", cleanup);
        document.removeEventListener("mouseleave", cleanup);
      };
      document.addEventListener("mouseup", cleanup);
      document.addEventListener("mouseleave", cleanup);
    },
    [disabled, value, step, clamp, onChange, stopRepeat],
  );

  const atMin = value <= min;
  const atMax = value >= max;
  const display = formatValue ? formatValue(value) : value.toLocaleString();

  const btnStyle = (isDisabled: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 28,
    borderRadius: 6,
    border: "1px solid var(--color-border)",
    background: "var(--color-bg)",
    color: isDisabled ? "var(--color-border)" : "var(--color-text-muted)",
    cursor: isDisabled ? "not-allowed" : "pointer",
    transition: "background 0.1s, color 0.1s",
  });

  return (
    <div
      className={className}
      role="group"
      aria-label={ariaLabel}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <button
        aria-label="Decrease"
        disabled={disabled || atMin}
        onMouseDown={() => !atMin && startRepeat(-1)}
        style={btnStyle(disabled || atMin)}
        onMouseEnter={(e) => {
          if (!atMin && !disabled) e.currentTarget.style.background = "var(--color-bg-tertiary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--color-bg)";
        }}
      >
        <Minus size={12} />
      </button>

      <span
        className="tabular-nums text-sm font-medium select-none"
        style={{ color: "var(--color-text)", minWidth: 48, textAlign: "center" }}
      >
        {display}
      </span>

      <button
        aria-label="Increase"
        disabled={disabled || atMax}
        onMouseDown={() => !atMax && startRepeat(1)}
        style={btnStyle(disabled || atMax)}
        onMouseEnter={(e) => {
          if (!atMax && !disabled) e.currentTarget.style.background = "var(--color-bg-tertiary)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "var(--color-bg)";
        }}
      >
        <Plus size={12} />
      </button>
    </div>
  );
});
