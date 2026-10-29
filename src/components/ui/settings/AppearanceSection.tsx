import React from "react";
import { Check } from "lucide-react";
import { useAppStore } from "../../../store";
import { THEMES } from "../../../lib/themes";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { APPEARANCE_INDEX, indexProps } from "./sectionIndexes";
import type { ThemeId } from "../../../types";
import type { SettingMeta } from "../../../lib/settingsIndex";

const m = indexProps(APPEARANCE_INDEX);
const DEFAULT_THEME: ThemeId = "dark";
const THEME_IDS = Object.keys(THEMES) as ThemeId[];

export const AppearanceSection = React.memo(function AppearanceSection() {
  const themeId  = useAppStore((s) => s.themeId);
  const setTheme = useAppStore((s) => s.setTheme);

  // Radio-group keyboard model: arrows move the selection, only the checked card is in the tab order.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = THEME_IDS.indexOf(themeId);
    const next = THEME_IDS[(i + step + THEME_IDS.length) % THEME_IDS.length];
    setTheme(next);
    (e.currentTarget.querySelector(`[data-theme-id="${next}"]`) as HTMLElement | null)?.focus();
  };

  return (
    <div className="settings-section-body">
      <SettingsGroup id="appearance.theme" title="Theme">
        <SettingRow
          {...m("appearance.theme.color-theme")}
          layout="stacked"
          modified={themeId !== DEFAULT_THEME}
          onReset={() => setTheme(DEFAULT_THEME)}
        >
          <div className="settings-theme-grid" role="radiogroup" aria-label="Color theme" onKeyDown={onKeyDown}>
            {THEME_IDS.map((id) => {
              const t = THEMES[id];
              const active = themeId === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  tabIndex={active ? 0 : -1}
                  data-theme-id={id}
                  onClick={() => setTheme(id)}
                  className="settings-theme-card"
                >
                  <span className="settings-theme-swatches" aria-hidden>
                    {[t.colors.bg, t.colors.primary, t.colors.accent].map((c, i) => (
                      <span key={i} className="settings-theme-swatch" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="settings-theme-name">{t.label}</span>
                  {active && <Check size={14} strokeWidth={2.5} className="settings-theme-check" aria-hidden />}
                </button>
              );
            })}
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = APPEARANCE_INDEX;
