import React from "react";
import { RotateCcw } from "lucide-react";
import { HelpTip } from "./HelpTip";
import { Tooltip } from "./Tooltip";
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
  /**
   * `inline` (default): label + description on the left, control on the right.
   * `stacked`: control on its own line under the text — for wide controls (pickers, sliders with ticks, text areas).
   * `compact`: a dense single-line row (lists such as keyboard shortcuts).
   */
  layout?: "inline" | "stacked" | "compact";
  /** Dims the row. The control itself should also receive `disabled`. */
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}

/**
 * One setting: a calm two-column row (text left, control right). Controls share one right edge across a
 * group so the column reads as aligned. Looks live in styles/settings.css (`.setting-row*`).
 */
export const SettingRow = React.memo(function SettingRow({
  id, label, description, help, keywords, modified, onReset, danger, layout = "inline", disabled, children, className,
}: SettingRowProps) {
  const query = useSettingsQuery();
  if (!matchesQuery(query, { label, description, keywords })) return null;
  const domId = id ? settingDomId(id) : undefined;
  const labelId = domId ? `${domId}-label` : undefined;
  const descId = domId && description ? `${domId}-desc` : undefined;
  return (
    <div
      id={domId}
      role="group"
      aria-labelledby={labelId}
      aria-describedby={descId}
      aria-disabled={disabled || undefined}
      data-setting-row
      data-layout={layout}
      data-modified={modified || undefined}
      data-danger={danger || undefined}
      data-disabled={disabled || undefined}
      className={`setting-row ${className ?? ""}`}
    >
      <div className="setting-row-text">
        <span id={labelId} className="setting-row-label">
          {modified && <span className="setting-row-marker" title="Modified from default" aria-label="Modified" role="img" />}
          {label}
          {help && <HelpTip text={help} />}
        </span>
        {description && <span id={descId} className="setting-row-desc">{description}</span>}
      </div>
      <div className="setting-row-control">
        {modified && onReset && !disabled && (
          <Tooltip content="Reset to default" delay={250}>
            <button type="button" className="setting-row-reset" aria-label={`Reset ${label} to default`} onClick={onReset}>
              <RotateCcw size={13} strokeWidth={2} />
            </button>
          </Tooltip>
        )}
        {children}
      </div>
    </div>
  );
});
