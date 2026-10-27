import { create } from "zustand";
import { vaultStatus } from "../lib/vault";
import { ensureVaultDir } from "../lib/vaultDir";

export type VaultDialogMode = "setup" | "unlock" | "recover";

interface VaultUiState {
  /** A vault.json exists on this device. */
  exists: boolean;
  /** The vault key is currently held in memory. */
  unlocked: boolean;
  /** Which dialog is open (null = none). */
  dialog: VaultDialogMode | null;
  /** The "back up your vault" dialog (onboarding / reminder). */
  backupPrompt: boolean;
  setBackupPrompt: (open: boolean) => void;

  refresh: () => Promise<void>;
  setUnlocked: (unlocked: boolean) => void;
  setDialog: (mode: VaultDialogMode | null) => void;
  /**
   * Resolves true once the vault is unlocked. Opens the setup / unlock dialog
   * if needed; resolves false if the user cancels.
   */
  ensureUnlocked: () => Promise<boolean>;
  /** Called by the dialog when it closes. */
  finish: (ok: boolean) => void;
}

let waiters: Array<(ok: boolean) => void> = [];

export const useVaultStore = create<VaultUiState>((set, get) => ({
  exists: false,
  unlocked: false,
  dialog: null,
  backupPrompt: false,
  setBackupPrompt(open) { set({ backupPrompt: open }); },

  async refresh() {
    try {
      await ensureVaultDir(); // tells the backend where vault.nqdb lives, before any vault command
      const s = await vaultStatus();
      set({ exists: s.exists, unlocked: s.unlocked });
    } catch (e) {
      console.warn("vault: status failed", e);
    }
  },

  setUnlocked(unlocked) {
    set(unlocked ? { unlocked, exists: true } : { unlocked });
  },

  setDialog(mode) { set({ dialog: mode }); },

  async ensureUnlocked() {
    await get().refresh();
    const s = get();
    if (s.unlocked) return true;
    return new Promise<boolean>((resolve) => {
      waiters.push(resolve);
      set({ dialog: s.exists ? "unlock" : "setup" });
    });
  },

  finish(ok) {
    set({ dialog: null });
    const pending = waiters;
    waiters = [];
    pending.forEach((r) => r(ok));
  },
}));
