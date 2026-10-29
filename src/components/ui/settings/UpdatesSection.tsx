import React, { useCallback, useState } from "react";
import { AlertTriangle, Download, RefreshCw, RotateCw } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { SettingsGroup, SettingsBlock } from "../SettingsGroup";
import { Button } from "../Button";
import { Toggle } from "../Toggle";
import { useUpdater } from "../../../hooks/useUpdater";
import { updater } from "../../../lib/updater";
import { useAppStore } from "../../../store";
import { isTauri } from "../../../lib/tauriWindow";
import { toast } from "../../../lib/toast";
import { APP_NAME, APP_VERSION } from "../../../config/app";
import { prefReset } from "./prefReset";
import { UPDATES_INDEX, indexProps } from "./sectionIndexes";
import type { SettingMeta } from "../../../lib/settingsIndex";

const m = indexProps(UPDATES_INDEX);

export const UpdatesSection = React.memo(function UpdatesSection() {
  const { status, version, error } = useUpdater();
  const autoUpdateCheck = useAppStore((s) => s.autoUpdateCheck);
  const setAutoUpdateCheck = useAppStore((s) => s.setAutoUpdateCheck);
  const [checking, setChecking] = useState(false);

  const runCheck = useCallback(async () => {
    if (!isTauri) { toast.info("Update checking only works in the desktop app"); return; }
    setChecking(true);
    try {
      const result = await updater.check();
      if (result === "available") updater.openDialog();
      else if (result === "uptodate") toast.info("You're on the latest version");
      else if (result === "error") toast.error(updater.getState().error ?? "Update check failed");
    } finally {
      setChecking(false);
    }
  }, []);

  const statusText =
    status === "checking"    ? "Checking for updates…" :
    status === "available"   ? `Version ${version} is available` :
    status === "downloading" ? "Downloading update…" :
    status === "ready"       ? "Update installed. Restart to apply it." :
    status === "error"       ? (error ?? "Update check failed") :
    status === "uptodate"    ? "You're on the latest version" :
    /* idle */                 "No newer version found so far";

  const updateReady = status === "available" || status === "ready";
  const busy = checking || status === "checking";

  return (
    <div className="settings-section-body">
      <SettingsGroup id="updates.status" title="Status">
        <SettingsBlock {...m("updates.status.current")}>
          <div className="settings-status" data-tone={status === "error" ? "danger" : undefined} role="status" aria-live="polite">
            <span className="settings-status-icon" aria-hidden>
              {status === "error" ? <AlertTriangle size={17} /> : <Download size={17} />}
            </span>
            <span className="settings-status-text">
              <span className="settings-status-title">{APP_NAME} v{APP_VERSION}</span>
              <span className="settings-status-sub">{statusText}</span>
            </span>
            {updateReady ? (
              <Button
                variant="primary"
                className="settings-btn-primary"
                icon={status === "ready" ? <RotateCw size={14} /> : <Download size={14} />}
                onClick={() => updater.openDialog()}
              >
                {status === "ready" ? "Restart" : "Update now"}
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="settings-btn"
                icon={<RefreshCw size={14} className={busy ? "animate-spin" : ""} />}
                onClick={runCheck}
                disabled={busy}
              >
                {busy ? "Checking…" : "Check now"}
              </Button>
            )}
          </div>
        </SettingsBlock>
      </SettingsGroup>

      <SettingsGroup
        id="updates.auto"
        title="Automatic updates"
        description="Updates come from the official GitHub releases and are verified before they install. Notiq always asks before it installs an update and restarts."
      >
        <SettingRow
          {...m("updates.auto.check")}
          {...prefReset("autoUpdateCheck", autoUpdateCheck, setAutoUpdateCheck)}
          help="On launch and then once an hour while Notiq is running (it can sit in the tray for days), Notiq quietly checks GitHub for a newer signed release and shows an Update button in the toolbar if one is available."
        >
          <Toggle value={autoUpdateCheck} onChange={setAutoUpdateCheck} aria-label="Check for updates automatically" />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = UPDATES_INDEX;
