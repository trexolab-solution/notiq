import React from "react";
import { Download, RotateCw, AlertTriangle } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "./Dialog";
import { useUpdater } from "../../hooks/useUpdater";
import { updater } from "../../lib/updater";
import { APP_VERSION } from "../../config/app";

/**
 * Update dialog: current → new version, release notes, a download progress bar,
 * and Install & Restart / Later actions. Driven entirely by the shared updater
 * state (`dialogOpen`), so the topbar pill and Settings → About both open it.
 */
export const UpdateDialog = React.memo(function UpdateDialog() {
  const { dialogOpen, status, version, notes, progress, error } = useUpdater();
  if (!dialogOpen) return null;

  const downloading = status === "downloading";
  const ready = status === "ready";
  const pct = Math.round(progress * 100);

  return (
    <Dialog
      size="md"
      title={ready ? "Update ready" : "Update available"}
      icon={<Download size={16} />}
      onClose={() => { if (!downloading) updater.closeDialog(); }}
      dismissable={!downloading}
    >
      <DialogBody
        message={<>Notiq v{APP_VERSION} → <span className="font-medium text-[var(--color-primary)]">v{version}</span></>}
      >
        {/* Release notes */}
        {notes && (
          <pre className="dlg-notes">{notes}</pre>
        )}

        {/* Progress */}
        {downloading && (
          <div className="mt-3" aria-live="polite">
            <div className="h-1.5 rounded-full overflow-hidden bg-[var(--color-bg-tertiary)]" role="progressbar"
                 aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Download progress">
              <div className="h-full bg-[var(--color-primary)] transition-[width] duration-150" style={{ width: `${pct}%` }} />
            </div>
            <p className="m-0 mt-1.5 text-[11px] text-[var(--color-text-muted)]">Downloading… {pct}%</p>
          </div>
        )}

        {/* Error */}
        {status === "error" && error && (
          <div role="alert" className="dlg-callout dlg-callout--danger mt-3">
            <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden />
            <span>{error}</span>
          </div>
        )}
      </DialogBody>

      <DialogFooter divided={!!notes}>
        {ready ? (
          <DialogButton variant="primary" icon={<RotateCw size={13} />} onClick={() => void updater.relaunchApp()}>
            Restart now
          </DialogButton>
        ) : downloading ? (
          <DialogButton disabled>Installing…</DialogButton>
        ) : (
          <>
            <DialogButton cancel onClick={() => updater.closeDialog()}>Later</DialogButton>
            <DialogButton variant="primary" icon={<Download size={13} />} onClick={() => void updater.install()}>
              {status === "error" ? "Retry" : "Install & Restart"}
            </DialogButton>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
});
