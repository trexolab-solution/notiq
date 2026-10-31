/**
 * The multi-step Vault Sync flows (turn on, machine-2 A/B/C, join from Drive) as plain async functions,
 * so the dialogs stay thin and the branching is unit-testable without a DOM.
 */
import {
  ERR_NO_REMOTE_VAULT, ERR_REMOTE_VAULT_DIFFERENT, ERR_WRONG_PASSWORD, isSyncError, syncAdoptRemote, syncEnable,
  syncErrorMessage, syncJoin, useSyncStore,
  type AdoptResult, type SyncResult,
} from "./vaultSync";

// ── Turn on ──────────────────────────────────────────────────────────────────

export type EnableOutcome =
  | { kind: "enabled"; result: SyncResult }
  /** Drive holds a different vault: show the A/B/C dialog. */
  | { kind: "different" }
  | { kind: "error"; error: string };

export async function enableSync(): Promise<EnableOutcome> {
  try {
    const result = await syncEnable();
    void useSyncStore.getState().refresh();
    return { kind: "enabled", result };
  } catch (e) {
    if (isSyncError(e, ERR_REMOTE_VAULT_DIFFERENT)) return { kind: "different" };
    return { kind: "error", error: syncErrorMessage(e) };
  }
}

// ── Machine 2 already has its own vault (A/B/C) ──────────────────────────────

/** A = import (default), B = back up only, C = cancel (UI only). */
export type AdoptChoice = "import" | "backupOnly" | "cancel";
export const DEFAULT_ADOPT_CHOICE: AdoptChoice = "import";

/** This PC's password is asked only to import from a vault that is locked right now. */
export const adoptNeedsLocalPassword = (choice: AdoptChoice, localUnlocked: boolean) =>
  choice === "import" && !localUnlocked;

export interface AdoptInput {
  choice: AdoptChoice;
  remotePassword: string;
  localPassword: string;
  localUnlocked: boolean;
}

export type AdoptOutcome =
  | { kind: "cancelled" }
  | { kind: "done"; result: AdoptResult; mode: "import" | "backupOnly" }
  | { kind: "invalid"; field: "remote" | "local"; error: string }
  | { kind: "error"; error: string };

export async function runAdopt(input: AdoptInput): Promise<AdoptOutcome> {
  const { choice } = input;
  if (choice === "cancel") return { kind: "cancelled" };
  if (!input.remotePassword) return { kind: "invalid", field: "remote", error: "Enter the synced vault's master password" };
  const needLocal = adoptNeedsLocalPassword(choice, input.localUnlocked);
  if (needLocal && !input.localPassword) {
    return { kind: "invalid", field: "local", error: "Enter this PC's master password" };
  }
  try {
    const result = await syncAdoptRemote(input.remotePassword, choice, needLocal ? input.localPassword : undefined);
    // The contract leaves live sync to the orchestrator; make sure it's on for this vault now.
    const st = await useSyncStore.getState().refresh();
    if (st && !st.enabled) {
      try { await syncEnable(); } catch { /* the Settings page shows the state */ }
      void useSyncStore.getState().refresh();
    }
    return { kind: "done", result, mode: choice };
  } catch (e) {
    if (isSyncError(e, ERR_WRONG_PASSWORD)) {
      return {
        kind: "error",
        error: needLocal
          ? "Wrong password. Check the synced vault's master password and this PC's master password."
          : "Wrong password. Enter the master password of the vault in your Google Drive.",
      };
    }
    return { kind: "error", error: syncErrorMessage(e) };
  }
}

/** The lines shown after A or B finished. */
export function describeAdoptResult(r: AdoptResult, mode: "import" | "backupOnly"): string[] {
  const lines = [`A backup of this PC's vault was saved to ${r.backupPath}`];
  if (mode === "import") {
    lines.push(
      `${r.imported} ${r.imported === 1 ? "entry was" : "entries were"} imported into the synced vault.`,
      `${r.skipped} identical ${r.skipped === 1 ? "entry was" : "entries were"} skipped.`,
    );
    if (r.renamed) {
      lines.push(`${r.renamed} ${r.renamed === 1 ? "entry differed and was" : "entries differed and were"} kept as "Name (This PC)".`);
    }
  }
  return lines;
}

export const HELLO_RESET_NOTE =
  "PC sign-in (Windows Hello) was turned off on this PC. Turn it on again in Settings → Vault → Quick unlock.";

// ── New device: join the vault from Drive (the steps before it: ./syncSetup decideAfterSignIn) ──

export type JoinOutcome =
  | { kind: "joined" }
  | { kind: "wrongPassword"; error: string }
  | { kind: "noRemote" }
  | { kind: "error"; error: string };

export async function runJoin(password: string): Promise<JoinOutcome> {
  if (!password) return { kind: "wrongPassword", error: "Enter your master password" };
  try {
    await syncJoin(password);
    void useSyncStore.getState().refresh();
    return { kind: "joined" };
  } catch (e) {
    if (isSyncError(e, ERR_WRONG_PASSWORD)) return { kind: "wrongPassword", error: "Wrong master password. Use the password of the vault in your Google Drive." };
    if (isSyncError(e, ERR_NO_REMOTE_VAULT)) return { kind: "noRemote" };
    return { kind: "error", error: syncErrorMessage(e) };
  }
}
