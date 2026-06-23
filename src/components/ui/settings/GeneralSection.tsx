import React, { useEffect, useState } from "react";
import { SettingRow } from "../SettingRow";
import { Toggle } from "../Toggle";
import { enable, disable, isEnabled } from "../../../lib/autostart";
import { toast } from "../../../lib/toast";

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
    <div className="flex flex-col gap-5">
      <h2 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>General</h2>

      <SettingRow
        label="Launch on system startup"
        description="Start Notiq automatically when you sign in. Runs minimized in the system tray."
      >
        <Toggle value={autostart} onChange={handleAutostartToggle} />
      </SettingRow>
    </div>
  );
});
