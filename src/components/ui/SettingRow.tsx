import React from "react";
import { HelpTip } from "./HelpTip";

interface SettingRowProps {
  label: string;
  description?: string;
  /** Optional detailed explanation shown via a "?" icon after the label. */
  help?: string;
  children: React.ReactNode;
  className?: string;
}

export const SettingRow = React.memo(function SettingRow({
  label,
  description,
  help,
  children,
  className,
}: SettingRowProps) {
  return (
    <div className={`flex items-start justify-between gap-4 ${className ?? ""}`}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium flex items-center gap-1.5" style={{ color: "var(--color-text)" }}>
          {label}
          {help && <HelpTip text={help} />}
        </span>
        {description && (
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
            {description}
          </span>
        )}
      </div>
      <div className="shrink-0 flex items-center">{children}</div>
    </div>
  );
});
