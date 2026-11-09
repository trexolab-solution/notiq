/**
 * Outbound deletion guard (Vault Sync). When a sync would remove entries that are live on Google Drive, the
 * backend stops in state "awaitingConfirm" and the user chooses: "Apply deletions everywhere" or "Restore from
 * Drive". Pure copy builders + the effect that runs the choice. The dialog is components/vault/sync/DeletionGuardDialog.
 */
import { create } from "zustand";
import { toast } from "./toast";
import {
  syncApplyDeletions, syncErrorMessage, syncRestoreFromDrive, useSyncStore,
  type PendingDeletions, type SyncResult, type SyncStatus,
} from "./vaultSync";
import { driveFirstMessage, itemsText } from "./syncSetup";
import { refreshVaultUi } from "./syncSetupFlow";

const SOURCE = "Vault sync";

/** Titles shown in the dialog list (the backend sends up to 8). */
export const GUARD_TITLES_SHOWN = 5;

export const guardTitle = (p: Pick<PendingDeletions, "removing">) => `Delete ${itemsText(p.removing)} from Google Drive?`;

/** The main explanation. */
export function guardMessage(p: Pick<PendingDeletions, "removing" | "remoteLive" | "reason">): string {
  const of = p.remoteLive > 0 ? ` of the ${itemsText(p.remoteLive)}` : "";
  const first = p.reason === "resume"
    ? "This is the first sync since sync was resumed on this PC. "
    : "";
  const what = p.remoteLive > 0 ? `${p.removing}${of}` : itemsText(p.removing);
  return `${first}Syncing this PC would remove ${what} in your Google Drive, and from your other devices too.`;
}

/** The short list of names: up to 5, then "and K more" (K counts everything not listed). */
export function guardTitleLines(p: Pick<PendingDeletions, "removing" | "titles">, shown = GUARD_TITLES_SHOWN): { titles: string[]; more: number; moreText: string | null } {
  const titles = p.titles.slice(0, shown);
  const more = Math.max(0, p.removing - titles.length);
  return { titles, more, moreText: more > 0 ? `and ${more} more` : null };
}

export const guardBackupLine = (p: Pick<PendingDeletions, "backupDir">) =>
  `A backup of the Google Drive copy is saved to ${p.backupDir} before anything is deleted.`;

export const GUARD_RESTORE_HINT = "Restore from Drive keeps everything that is in your Google Drive and brings these items back to this PC.";

/** Stable identity of a pending decision: "Decide later" hides the dialog until this changes. */
export const guardKey = (p: PendingDeletions): string => `${p.reason}:${p.removing}:${p.remoteLive}`;

/** The dialog is wanted: sync is waiting for a decision and the user hasn't postponed this exact one. */
export function shouldShowGuard(status: SyncStatus | null | undefined, dismissedKey: string | null): boolean {
  const p = status?.pendingDeletions;
  if (!status || !status.enabled || status.state !== "awaitingConfirm" || !p) return false;
  return dismissedKey !== guardKey(p);
}

// ── Dismissed ("Decide later") + busy state ──────────────────────────────────

interface GuardUi {
  dismissedKey: string | null;
  busy: "apply" | "restore" | null;
  dismiss: (key: string) => void;
  /** "Review…" buttons: show the dialog again. */
  reopen: () => void;
  setBusy: (b: "apply" | "restore" | null) => void;
}

export const useDeletionGuardUi = create<GuardUi>((set) => ({
  dismissedKey: null,
  busy: null,
  dismiss: (key) => set({ dismissedKey: key }),
  reopen: () => set({ dismissedKey: null }),
  setBusy: (busy) => set({ busy }),
}));

// ── The choice ───────────────────────────────────────────────────────────────

export type GuardOutcome =
  | { ok: true; choice: "apply" | "restore"; result: SyncResult; backupPath: string | null }
  | { ok: false; error: string };

/** Runs "apply" or "restore", refreshes the sync status, toasts the outcome. Never throws. */
export async function runGuardChoice(choice: "apply" | "restore"): Promise<GuardOutcome> {
  const ui = useDeletionGuardUi.getState();
  ui.setBusy(choice);
  try {
    const out = choice === "apply" ? await syncApplyDeletions() : await syncRestoreFromDrive();
    if (choice === "apply") {
      toast.success("Deleted from Google Drive · backup saved", { source: SOURCE, detail: out.backupPath ?? undefined });
    } else {
      toast.success(driveFirstMessage(out.result), { source: SOURCE, detail: out.backupPath ?? undefined });
    }
    await refreshVaultUi().catch(() => {}); // restored items show up without a reload
    return { ok: true, choice, result: out.result, backupPath: out.backupPath };
  } catch (e) {
    const error = syncErrorMessage(e);
    toast.error("Couldn't finish the sync", { source: SOURCE, detail: error });
    return { ok: false, error };
  } finally {
    useDeletionGuardUi.getState().setBusy(null);
    await useSyncStore.getState().refresh();
  }
}
