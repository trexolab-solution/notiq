import React from "react";

interface ToggleProps {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}

const SIZES = {
  sm: { track: { w: 32, h: 18 }, thumb: 12, offset: 2 },
  md: { track: { w: 40, h: 22 }, thumb: 16, offset: 2 },
} as const;

export const Toggle = React.memo(function Toggle({
  value,
  onChange,
  disabled,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: ToggleProps) {
  const s = SIZES[size];

  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!value)}
      className={className}
      style={{
        position: "relative",
        width: s.track.w,
        height: s.track.h,
        borderRadius: s.track.h / 2,
        background: value ? "var(--color-primary)" : "var(--color-bg-tertiary)",
        border: "1px solid",
        borderColor: value ? "var(--color-primary)" : "var(--color-border)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "background 0.15s, border-color 0.15s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: s.offset,
          left: value ? s.track.w - s.thumb - s.offset - 2 : s.offset,
          width: s.thumb,
          height: s.thumb,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          transition: "left 0.15s",
        }}
      />
    </button>
  );
});
