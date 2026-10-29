import React from "react";
import { ALL_SHORTCUTS, SHORTCUT_GROUPS, type ShortcutEntry } from "./settingsConstants";
import { getPanicShortcut } from "../../../lib/vaultPrefs";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { SHORTCUTS_INDEX, shortcutDescription, shortcutId, shortcutKeywords } from "./sectionIndexes";
import type { SettingMeta } from "../../../lib/settingsIndex";

/** "Ctrl+⇧+S" → ["Ctrl", "Shift", "S"]. A trailing "+" (none today) would be kept as its own key. */
function splitKeys(combo: string): string[] {
  return combo.split("+").filter(Boolean).map((k) => (k === "⇧" ? "Shift" : k));
}

const Keys = React.memo(function Keys({ combo }: { combo: string }) {
  const keys = splitKeys(combo);
  return (
    <span className="settings-keys" aria-label={keys.join(" + ")}>
      {keys.map((k, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="settings-keys-plus" aria-hidden>+</span>}
          <kbd className="settings-kbd" aria-hidden>{k}</kbd>
        </React.Fragment>
      ))}
    </span>
  );
});

export const ShortcutsSection = React.memo(function ShortcutsSection() {
  // The vault lock shortcut is user-configurable (Vault settings); show the live value.
  const keyOf = (s: ShortcutEntry) => (s.label === "Lock vault now" ? getPanicShortcut() : s.key);
  return (
    <div className="settings-section-body">
      <p className="settings-page-intro">
        Keyboard shortcuts, grouped by where they work. Search settings for a key name, such as
        “ctrl shift”, to find what a combination does.
      </p>
      {SHORTCUT_GROUPS.map((grp) => {
        const rows = ALL_SHORTCUTS.filter((s) => s.section === grp);
        if (rows.length === 0) return null;
        return (
          <SettingsGroup key={grp} id={`shortcuts.${grp.toLowerCase()}`} title={grp}>
            {rows.map((s) => (
              <SettingRow
                key={shortcutId(s)}
                id={shortcutId(s)}
                label={s.label}
                description={shortcutDescription(s)}
                keywords={shortcutKeywords(s)}
                layout="compact"
              >
                <Keys combo={keyOf(s)} />
              </SettingRow>
            ))}
          </SettingsGroup>
        );
      })}
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = SHORTCUTS_INDEX;
