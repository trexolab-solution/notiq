import React, { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { enable, disable, isEnabled } from "../../../lib/autostart";
import { toast } from "../../../lib/toast";
import { GENERAL_INDEX, indexProps } from "./sectionIndexes";
import type { SettingMeta } from "../../../lib/settingsIndex";

const m = indexProps(GENERAL_INDEX);

export const GeneralSection = React.memo(function GeneralSection() {
  // Auto-start state is owned by the OS (registry / LaunchAgent / .desktop),
  // so we read it asynchronously on mount and reflect changes via enable/disable.
  const [autostart, setAutostart] = useState<boolean>(false);
  const [busy,      setBusy]      = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    isEnabled()
      .then((v) => { if (!cancelled) setAutostart(v); })
      .catch(() => { /* dev / portable build — ignore */ });
    return () => { cancelled = true; };
  }, []);

  const handleAutostartToggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setAutostart(next); // optimistic
    try {
      if (next) await enable();
      else      await disable();
    } catch (err) {
      console.error("autostart toggle failed", err);
      toast.error("Could not change auto-start setting");
      // Revert optimistic state by re-reading actual value.
      try { setAutostart(await isEnabled()); } catch { /* ignore */ }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section-body">
      <SettingsGroup id="general.startup" title="Startup">
        {/* Off is the OS default, so "on" counts as modified. */}
        <SettingRow {...m("general.startup.launch")} modified={autostart} onReset={() => handleAutostartToggle(false)}>
          <Toggle value={autostart} onChange={handleAutostartToggle} aria-label="Launch at sign-in" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="general.help" title="Help">
        <SettingRow {...m("general.help.tour")}>
          <Button variant="ghost" size="md" className="settings-btn" onClick={() => window.dispatchEvent(new Event("app:start-tour"))}>
            Replay tour
          </Button>
        </SettingRow>
        <SettingRow {...m("general.help.whats-new")}>
          <Button variant="ghost" size="md" className="settings-btn" onClick={() => window.dispatchEvent(new Event("app:show-whats-new"))}>
            Open release notes
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = GENERAL_INDEX;
