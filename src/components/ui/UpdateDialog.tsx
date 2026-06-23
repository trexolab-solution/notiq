import React from "react";
import { Download, RotateCw, AlertTriangle } from "lucide-react";
import { Modal } from "./Modal";
import { Button } from "./Button";
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
    <Modal onClose={() => { if (!downloading) updater.closeDialog(); }} dismissable={!downloading}>
      <div className="w-[440px] max-w-[92vw] rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0 text-[var(--color-primary)]"
            style={{ background: "color-mix(in srgb, var(--color-primary) 12%, transparent)" }}
          >
            <Download size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-text)] m-0">
              {ready ? "Update ready" : "Update available"}
            </h2>
            <p className="text-xs text-[var(--color-text-muted)] m-0">
              v{APP_VERSION} → <span className="font-medium text-[var(--color-primary)]">v{version}</span>
            </p>
          </div>
        </div>

        {/* Release notes */}
        {notes && (
          <div className="px-5 pb-1 max-h-[220px] overflow-auto">
            <pre className="m-0 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-[var(--color-text-muted)]">
              {notes}
            </pre>
          </div>
        )}

        {/* Progress */}
        {downloading && (
          <div className="px-5 py-3">
            <div className="h-1.5 rounded-full overflow-hidden bg-[var(--color-bg-tertiary)]">
              <div className="h-full bg-[var(--color-primary)] transition-[width] duration-150" style={{ width: `${pct}%` }} />
            </div>
            <p className="m-0 mt-1.5 text-[11px] text-[var(--color-text-muted)]">Downloading… {pct}%</p>
          </div>
        )}

        {/* Error */}
        {status === "error" && error && (
          <div className="flex items-start gap-2 mx-5 my-2 p-2.5 rounded-lg text-xs text-[var(--color-danger)]"
               style={{ background: "color-mix(in srgb, var(--color-danger) 10%, transparent)" }}>
            <AlertTriangle size={14} className="shrink-0 mt-px" />
            <span>{error}</span>
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--color-border)]">
          {ready ? (
            <Button variant="primary" size="md" icon={<RotateCw size={14} />} onClick={() => void updater.relaunchApp()}>
              Restart now
            </Button>
          ) : downloading ? (
            <Button variant="ghost" size="md" disabled>Installing…</Button>
          ) : (
            <>
              <Button variant="ghost" size="md" onClick={() => updater.closeDialog()}>Later</Button>
              <Button variant="primary" size="md" icon={<Download size={14} />} onClick={() => void updater.install()}>
                {status === "error" ? "Retry" : "Install & Restart"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
});
