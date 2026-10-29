import React from "react";
import { HelpTip } from "./HelpTip";
import { matchesQuery, useSettingsQuery } from "../settings/settingsFilter";
import { settingDomId } from "../../lib/settingsIndex";

interface SettingRowProps {
  /** Globally unique id from the section's SETTINGS_INDEX ("<section>.<group>.<name>"): enables deep links and "reveal". */
  id?: string;
  label: string;
  description?: string;
  /** Optional detailed explanation shown via a "?" icon after the label. */
  help?: string;
  /** Extra search words (also list them in SETTINGS_INDEX). */
  keywords?: string[];
  /** The value differs from the default: shows the "modified" marker (and Reset when `onReset` is given). */
  modified?: boolean;
  /** Puts the setting back to its default. */
  onReset?: () => void;
  /** Destructive / risky setting: styled as a danger row. */
  danger?: boolean;
  children: React.ReactNode;
  className?: string;
}

export const SettingRow = React.memo(function SettingRow({
  id, label, description, help, keywords, modified, onReset, danger, children, className,
}: SettingRowProps) {
  const query = useSettingsQuery();
  if (!matchesQuery(query, { label, description, keywords })) return null;
  return (
    <div
      id={id ? settingDomId(id) : undefined}
      data-setting-row
      data-modified={modified || undefined}
      data-danger={danger || undefined}
      className={`flex items-start justify-between gap-4 ${className ?? ""}`}
    >
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
      <div className="shrink-0 flex items-center">
        {children}
        {modified && onReset && (
          <button type="button" className="ml-2 text-[11px] underline cursor-pointer text-[var(--color-text-muted)]" onClick={onReset}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
});
