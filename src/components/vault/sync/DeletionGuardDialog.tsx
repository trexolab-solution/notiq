import { useRef } from "react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../../ui/Dialog";
import {
  GUARD_RESTORE_HINT, guardBackupLine, guardKey, guardMessage, guardTitle, guardTitleLines, runGuardChoice,
  shouldShowGuard, useDeletionGuardUi,
} from "../../../lib/syncDeletionGuard";
import { useSyncStore, type PendingDeletions } from "../../../lib/vaultSync";

export interface DeletionGuardViewProps {
  pending: PendingDeletions;
  busy: "apply" | "restore" | null;
  onRestore: () => void;
  onApply: () => void;
  onLater: () => void;
}

/**
 * "Delete N items from Google Drive?" Sync stopped before removing entries that are live in Drive. The safe
 * choice (Restore from Drive) has the initial focus; Enter never fires the destructive one.
 */
export function DeletionGuardView({ pending, busy, onRestore, onApply, onLater }: DeletionGuardViewProps) {
  const restoreRef = useRef<HTMLButtonElement>(null);
  const { titles, moreText } = guardTitleLines(pending);
  return (
    <Dialog
      role="alertdialog" size="md" title={guardTitle(pending)} icon="warning" zClassName="z-[96000]"
      initialFocusRef={restoreRef} dismissable={!busy} onClose={onLater} data-testid="deletion-guard"
    >
      <DialogBody message={guardMessage(pending)} detail={GUARD_RESTORE_HINT}>
        {titles.length > 0 && (
          <ul className="dlg-detail dlg-detail--block m-0 mt-2 pl-5 list-disc" aria-label="Items that would be deleted">
            {titles.map((t, i) => <li key={`${i}:${t}`}>{t}</li>)}
            {moreText && <li className="list-none -ml-5 italic">{moreText}</li>}
          </ul>
        )}
        <p className="dlg-detail dlg-detail--block mt-3 mb-0">{guardBackupLine(pending)}</p>
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onLater} disabled={!!busy}>Decide later</DialogButton>
        <DialogButton variant="danger" onClick={onApply} disabled={!!busy}
                      loading={busy === "apply"} loadingText="Deleting…">
          Apply deletions everywhere
        </DialogButton>
        <DialogButton ref={restoreRef} variant="primary" onClick={onRestore} disabled={busy === "apply"}
                      loading={busy === "restore"} loadingText="Restoring…">
          Restore from Drive
        </DialogButton>
      </DialogFooter>
    </Dialog>
  );
}

/** Mounted once (SyncSetupHost). Reads the sync status itself and shows while a decision is pending. */
export function DeletionGuardDialog() {
  const status = useSyncStore((s) => s.status);
  const dismissedKey = useDeletionGuardUi((s) => s.dismissedKey);
  const busy = useDeletionGuardUi((s) => s.busy);
  const dismiss = useDeletionGuardUi((s) => s.dismiss);
  const pending = status?.pendingDeletions;
  // While a choice runs the status may already have moved on: keep the dialog until it settles.
  if (!pending || (!busy && !shouldShowGuard(status, dismissedKey))) return null;
  return (
    <DeletionGuardView
      pending={pending} busy={busy}
      onRestore={() => { void runGuardChoice("restore"); }}
      onApply={() => { void runGuardChoice("apply"); }}
      onLater={() => dismiss(guardKey(pending))}
    />
  );
}
