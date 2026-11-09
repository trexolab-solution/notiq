import { useCallback, useEffect, useId, useState } from "react";
import { AlertTriangle, History, RefreshCw } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter, DialogText } from "../Dialog";
import { InlineLoading, Spinner } from "../Loading";
import { toast } from "../../../lib/toast";
import { syncErrorMessage } from "../../../lib/vaultSync";
import { deviceDisplayName } from "../../../lib/syncSurfaces";
import { useVaultStore } from "../../../store/vaultStore";
import {
  HISTORY_KEEP_DAYS, describeRestore, formatRestoreDate, formatSize, groupRestorePoints, syncHistoryList,
  syncHistoryRestore, type RestorePoint, type RestoreSummary,
} from "../../../lib/syncHistory";

type Step =
  | { kind: "choose" }
  | { kind: "confirm"; error: string | null }
  | { kind: "restoring" }
  | { kind: "done"; summary: RestoreSummary };

export const RESTORE_TITLE = "Restore vault from a date";

/** The device a point came from: its name, never an id ("Unnamed device" when unknown). */
const pointDevice = (p: RestorePoint) => deviceDisplayName({ name: p.deviceName });

const timeOf = (p: RestorePoint) =>
  p.takenMs ? new Date(p.takenMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : null;

/** One line about a point: device (never an id), what it is, when, size. */
function pointDetail(p: RestorePoint): string {
  const time = timeOf(p);
  const what = p.kind === "checkpoint" ? "Copy before a large change" : "Daily copy";
  return [what, time && `${p.kind === "checkpoint" ? "at" : "saved"} ${time}`, formatSize(p.size)].filter(Boolean).join(" · ");
}

/**
 * Settings → Sync → "Restore vault from a date…": pick a restore point (grouped by date, with the
 * device it came from), confirm, restore (merge, nothing removed, backup first), see the result.
 */
export function SyncHistoryDialog({ onClose }: { onClose: () => void }) {
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const uid = useId();

  const load = useCallback(async () => {
    setLoadError(null);
    setPoints(null);
    try {
      setPoints(await syncHistoryList());
    } catch (e) {
      setLoadError(syncErrorMessage(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const point = points?.find((p) => p.id === selected) ?? null;
  const restoring = step.kind === "restoring";

  const restore = async () => {
    if (!point) return;
    if (!(await useVaultStore.getState().ensureUnlocked())) return;
    setStep({ kind: "restoring" });
    try {
      const summary = await syncHistoryRestore(point.id);
      setStep({ kind: "done", summary });
      toast.success(`Restored your vault from ${formatRestoreDate(summary.date)}`, { source: "Vault sync", detail: describeRestore(summary) });
    } catch (e) {
      setStep({ kind: "confirm", error: syncErrorMessage(e) });
    }
  };

  const close = () => { if (!restoring) onClose(); };

  return (
    <Dialog size="lg" title={RESTORE_TITLE} icon={<History size={16} />} onClose={close} dismissable={!restoring}
            data-testid="sync-history-dialog">
      {step.kind === "choose" && (
        <>
          <DialogBody
            message="Choose the copy to bring back."
            detail={`Your Google Drive keeps one encrypted copy of the vault per device per day for ${HISTORY_KEEP_DAYS} days. Dates are in UTC.`}
          >
            {loadError ? (
              <div role="alert" className="dlg-callout dlg-callout--danger mt-3">
                <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden />
                <span>Couldn't load the restore points: {loadError}</span>
              </div>
            ) : !points ? (
              <div className="mt-3"><InlineLoading label="Loading restore points…" /></div>
            ) : points.length === 0 ? (
              <DialogText className="mt-3">
                There are no restore points yet. A copy is saved after the first sync of each day.
              </DialogText>
            ) : (
              <div role="radiogroup" aria-label="Restore points"
                   className="mt-3 max-h-[46vh] overflow-y-auto rounded-md border border-[var(--color-border)]">
                {groupRestorePoints(points).map((g) => (
                  <div key={g.date} role="group" aria-labelledby={`${uid}-${g.date}`}>
                    <div id={`${uid}-${g.date}`}
                         className="sticky top-0 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)] border-b border-[var(--color-border)]">
                      {g.label}
                    </div>
                    <ul className="m-0 p-0 list-none divide-y divide-[var(--color-border)]">
                      {g.points.map((p) => (
                        <li key={p.id}>
                          <label className={`flex items-center gap-2.5 px-2.5 py-1.5 cursor-pointer hover:bg-[var(--color-bg-tertiary)]${selected === p.id ? " bg-[var(--color-bg-tertiary)]" : ""}`}>
                            <input type="radio" name={`${uid}-point`} value={p.id} checked={selected === p.id}
                                   onChange={() => setSelected(p.id)} className="accent-[var(--color-primary)]"
                                   aria-label={`${g.label}, ${pointDevice(p)}${p.thisDevice ? " (this PC)" : ""}`} />
                            <span className="flex-1 min-w-0">
                              <span className="flex items-center gap-1.5 min-w-0">
                                <span className={`text-sm truncate${p.deviceName.trim() ? "" : " italic text-[var(--color-text-muted)]"}`}>
                                  {pointDevice(p)}
                                </span>
                                {p.thisDevice && <span className="sync-device__badge">This PC</span>}
                              </span>
                              <span className="block text-[11px] text-[var(--color-text-muted)]">{pointDetail(p)}</span>
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </DialogBody>
          <DialogFooter divided start={loadError ? (
            <DialogButton variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void load()}>Retry</DialogButton>
          ) : undefined}>
            <DialogButton cancel onClick={close}>Cancel</DialogButton>
            <DialogButton variant="primary" disabled={!point} onClick={() => setStep({ kind: "confirm", error: null })}>
              Continue…
            </DialogButton>
          </DialogFooter>
        </>
      )}

      {(step.kind === "confirm" || step.kind === "restoring") && point && (
        <>
          <DialogBody
            message={<>Restore your vault from <strong>{formatRestoreDate(point.date)}</strong> ({pointDevice(point)})?</>}
          >
            <ul className="mt-2 mb-0 pl-5 flex flex-col gap-1 text-[13px] text-[var(--color-text)]">
              <li>Notes from that date come back and are merged into your vault.</li>
              <li>Nothing is removed. Notes you changed since then keep their newer text; the restored version goes into their history.</li>
              <li>A backup of your vault is saved on this PC first.</li>
              <li>Your other devices get the restored notes on their next sync.</li>
            </ul>
            {step.kind === "restoring" && (
              <div role="status" aria-live="polite" className="mt-3 flex items-center gap-2 text-[13px] text-[var(--color-text-muted)]">
                <Spinner size={14} /> Restoring… downloading, checking and merging the copy.
              </div>
            )}
            {step.kind === "confirm" && step.error && (
              <div role="alert" className="dlg-callout dlg-callout--danger mt-3">
                <AlertTriangle size={14} className="shrink-0 mt-px" aria-hidden />
                <span>The restore failed: {step.error} Your vault wasn't changed.</span>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogButton cancel disabled={restoring} onClick={() => setStep({ kind: "choose" })}>Back</DialogButton>
            <DialogButton variant="primary" icon={<History size={13} />} loading={restoring} loadingText="Restoring…"
                          onClick={() => void restore()}>
              {step.kind === "confirm" && step.error ? "Try again" : "Restore"}
            </DialogButton>
          </DialogFooter>
        </>
      )}

      {step.kind === "done" && (
        <>
          <DialogBody
            icon="success"
            message={`Restored from ${formatRestoreDate(step.summary.date)}.`}
            detail={describeRestore(step.summary)}
          >
            {step.summary.backupPath && (
              <DialogText className="mt-2">
                Your vault as it was before the restore is saved in <span className="break-all">{step.summary.backupPath}</span>.
              </DialogText>
            )}
          </DialogBody>
          <DialogFooter>
            <DialogButton variant="primary" onClick={onClose}>Done</DialogButton>
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
