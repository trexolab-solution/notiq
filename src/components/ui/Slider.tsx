import React, { useCallback, useRef } from "react";
import { RotateCcw } from "lucide-react";

interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  showValue?: boolean;
  formatValue?: (v: number) => string;
  resetValue?: number;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

export const Slider = React.memo(function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  showValue = true,
  formatValue,
  resetValue,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);

  const clamp = useCallback(
    (v: number) => {
      const snapped = Math.round(v / step) * step;
      // Round to avoid floating point drift
      const rounded = Number(snapped.toFixed(10));
      return Math.min(max, Math.max(min, rounded));
    },
    [min, max, step],
  );

  const valueFromX = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return value;
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return clamp(min + ratio * (max - min));
    },
    [clamp, min, max, value],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      e.preventDefault();
      const next = valueFromX(e.clientX);
      onChange(next);

      const onMove = (ev: PointerEvent) => onChange(valueFromX(ev.clientX));
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    },
    [disabled, valueFromX, onChange],
  );

  const pct = ((value - min) / (max - min)) * 100;
  const displayValue = formatValue ? formatValue(value) : String(value);

  return (
    <div
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {/* Hidden accessible range input */}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={ariaLabel}
        disabled={disabled}
        className="sr-only"
      />

      {/* Custom track */}
      <div
        ref={trackRef}
        onPointerDown={handlePointerDown}
        style={{
          position: "relative",
          width: 128,
          height: 20,
          cursor: disabled ? "not-allowed" : "pointer",
          display: "flex",
          alignItems: "center",
        }}
      >
        {/* Track background */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            height: 4,
            borderRadius: 2,
            background: "var(--color-bg-tertiary)",
          }}
        />
        {/* Filled portion */}
        <div
          style={{
            position: "absolute",
            left: 0,
            width: `${pct}%`,
            height: 4,
            borderRadius: 2,
            background: "var(--color-primary)",
          }}
        />
        {/* Thumb */}
        <div
          style={{
            position: "absolute",
            left: `${pct}%`,
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: "var(--color-primary)",
            border: "2px solid #fff",
            boxShadow: "0 1px 4px rgba(0,0,0,0.3)",
            transform: "translateX(-50%)",
            transition: "transform 0.1s",
          }}
          onMouseEnter={(e) => {
            if (!disabled) e.currentTarget.style.transform = "translateX(-50%) scale(1.15)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = "translateX(-50%)";
          }}
        />
      </div>

      {showValue && (
        <span className="tabular-nums text-sm font-medium text-[var(--color-primary)] min-w-[32px] text-right">
          {displayValue}
        </span>
      )}

      {resetValue !== undefined && (
        <button
          type="button"
          onClick={() => {
            if (!disabled && value !== resetValue) onChange(resetValue);
          }}
          aria-label="Reset to default"
          title="Reset to default"
          tabIndex={value === resetValue ? -1 : 0}
          // visibility (not display:none) reserves layout space so the track
          // does not shift sideways mid-drag when the value changes.
          style={{
            visibility: value === resetValue ? "hidden" : "visible",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 22,
            height: 22,
            border: "none",
            borderRadius: 5,
            background: "transparent",
            color: "var(--color-text-muted)",
            cursor: "pointer",
            transition: "background 0.1s, color 0.1s",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--color-bg-tertiary)";
            e.currentTarget.style.color = "var(--color-text)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--color-text-muted)";
          }}
        >
          <RotateCcw size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
});
