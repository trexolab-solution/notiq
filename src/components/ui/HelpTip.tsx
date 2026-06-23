import React from "react";
import { HelpCircle } from "lucide-react";
import { Tooltip } from "./Tooltip";

interface HelpTipProps {
  /** The explanation shown on hover/focus. */
  text: string;
  size?: number;
}

/**
 * A small "?" help icon placed at the end of a setting label. Shows a detailed
 * explanation on hover or keyboard focus (portal tooltip — never clipped).
 */
export const HelpTip = React.memo(function HelpTip({ text, size = 13 }: HelpTipProps) {
  return (
    <Tooltip
      delay={150}
      content={<span style={{ display: "block", maxWidth: 250, lineHeight: 1.45, whiteSpace: "normal" }}>{text}</span>}
    >
      <button
        type="button"
        aria-label="Help"
        onClick={(e) => e.preventDefault()}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 16, height: 16, padding: 0, border: "none", borderRadius: "50%",
          background: "transparent", color: "var(--color-text-muted)",
          cursor: "help", flexShrink: 0, transition: "color 0.1s",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--color-primary)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--color-text-muted)"; }}
      >
        <HelpCircle size={size} strokeWidth={2} />
      </button>
    </Tooltip>
  );
});
