import React, { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup } from "../SettingsGroup";
import { Toggle } from "../Toggle";
import { Button } from "../Button";
import { setAutostart as saveAutostart, isEnabled } from "../../../lib/autostart";
import { toast } from "../../../lib/toast";
import { GENERAL_INDEX, indexProps } from "./sectionIndexes";
import type { SettingMeta } from "../../../lib/settingsIndex";

const m = indexProps(GENERAL_INDEX);

export const GeneralSection = React.memo(function GeneralSection() {
  // Auto-start state is owned by the OS (registry / LaunchAgent / .desktop),
  // so we read it asynchronously on mount and reflect changes via enable/disable.
  const [autostart, setAutostart] = useState<boolean>(false);
  const [busy,      setBusy]      = useState<boolean>(false);
  const [loaded,    setLoaded]    = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    isEnabled()
      .then((v) => { if (!cancelled) { setAutostart(v); setLoaded(true); } })
      .catch(() => { /* dev / portable build — ignore */ });
    return () => { cancelled = true; };
  }, []);

  const handleAutostartToggle = async (next: boolean) => {
    if (busy) return;
    if (import.meta.env.DEV) { toast.info("A development build doesn't change what starts with Windows"); return; }
    setBusy(true);
    setAutostart(next); // optimistic
    try {
      await saveAutostart(next);
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
        {/* Notiq turns this on at first run, so "off" counts as modified. Not known until read, nor in a dev build. */}
        <SettingRow {...m("general.startup.launch")} modified={loaded && !autostart && !import.meta.env.DEV} onReset={() => handleAutostartToggle(true)}>
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
