import React, { useCallback, useState } from "react";
import { Download, RefreshCw, RotateCw } from "lucide-react";
import { SettingRow } from "../SettingRow";
import { Button } from "../Button";
import { Toggle } from "../Toggle";
import { useUpdater } from "../../../hooks/useUpdater";
import { updater } from "../../../lib/updater";
import { useAppStore } from "../../../store";
import { isTauri } from "../../../lib/tauriWindow";
import { toast } from "../../../lib/toast";
import { APP_NAME, APP_VERSION } from "../../../config/app";

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
    status === "ready"       ? "Update installed — restart to apply" :
    status === "error"       ? (error ?? "Update check failed") :
    status === "uptodate"    ? "You're on the latest version" :
    /* idle */                 "Up to date as far as we know";

  const updateReady = status === "available" || status === "ready";

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-base font-semibold text-[var(--color-text)]">Updates</h2>

      {/* Current version + primary action */}
      <div className="flex items-center gap-3 p-3.5 rounded-lg bg-[var(--color-bg-tertiary)]">
        <div
          className="flex items-center justify-center w-10 h-10 rounded-lg shrink-0 text-[var(--color-primary)]"
          style={{ background: "color-mix(in srgb, var(--color-primary) 12%, transparent)" }}
        >
          <Download size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--color-text)]">{APP_NAME} v{APP_VERSION}</div>
          <div className="text-xs text-[var(--color-text-muted)]">{statusText}</div>
        </div>
        {updateReady ? (
          <Button
            variant="primary"
            size="sm"
            icon={status === "ready" ? <RotateCw size={13} /> : <Download size={13} />}
            onClick={() => updater.openDialog()}
          >
            {status === "ready" ? "Restart" : "Update now"}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw size={13} className={checking || status === "checking" ? "animate-spin" : ""} />}
            onClick={runCheck}
            disabled={checking || status === "checking"}
          >
            {checking || status === "checking" ? "Checking…" : "Check now"}
          </Button>
        )}
      </div>

      <SettingRow
        label="Check automatically"
        description="Look for updates each time Notiq starts."
        help="On launch, Notiq quietly checks GitHub for a newer signed release and shows an Update button in the toolbar if one is available."
      >
        <Toggle value={autoUpdateCheck} onChange={setAutoUpdateCheck} aria-label="Auto-check for updates" />
      </SettingRow>

      <p className="text-xs leading-relaxed text-[var(--color-text-muted)]">
        Updates are downloaded from the official GitHub releases and cryptographically verified before
        installing. You'll always be asked before an update is installed and the app restarts.
      </p>
    </div>
  );
});
