import React from "react";

interface SegmentedControlOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedControlOption<T>[];
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

function SegmentedControlInner<T extends string>({
  value,
  onChange,
  options,
  disabled,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: 2,
        borderRadius: 8,
        background: "var(--color-bg-tertiary)",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => !disabled && onChange(o.value)}
            style={{
              padding: "4px 12px",
              borderRadius: 6,
              fontSize: 12,
              fontWeight: active ? 600 : 400,
              color: active ? "#fff" : "var(--color-text-muted)",
              background: active ? "var(--color-primary)" : "transparent",
              boxShadow: active ? "0 1px 3px rgba(0,0,0,0.2)" : "none",
              border: "none",
              cursor: disabled ? "not-allowed" : "pointer",
              transition: "background 0.15s, color 0.15s, box-shadow 0.15s",
              whiteSpace: "nowrap",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export const SegmentedControl = React.memo(SegmentedControlInner) as typeof SegmentedControlInner;
