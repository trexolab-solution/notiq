import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { vaultStatus, VAULT_CHANGED_EVENT } from "../lib/vault";
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

// ── Cross-window sync ─────────────────────────────────────────────────────────
// The backend emits `vault:state-changed` ({unlocked, source}) whenever a command unlocks or locks the
// vault; `source` is the label of the window that ran it. The autofill prompt window can unlock the
// vault on its own, and the main window has to follow without redoing work it did itself.

export const VAULT_STATE_EVENT = "vault:state-changed";
/** The autofill prompt window wrote to the vault (a saved login): refresh the tree and open tabs. */
export const VAULT_ENTRIES_EVENT = "vault:entries-changed";

export interface VaultStateEvent { unlocked: boolean; source?: string }
export type VaultSyncAction = "ignore" | "unlocked" | "locked";

/**
 * What a window should do with a state event. Its own commands already updated it (`source` is
 * itself), and an event that matches what it already shows changes nothing; so there is no echo
 * and no double work.
 */
export function vaultSyncAction(ev: VaultStateEvent, local: { unlocked: boolean }, self: string): VaultSyncAction {
  if (!ev || typeof ev.unlocked !== "boolean" || ev.source === self) return "ignore";
  if (ev.unlocked && !local.unlocked) return "unlocked";
  if (!ev.unlocked && local.unlocked) return "locked";
  return "ignore";
}

/**
 * Main window only: follow unlocks done elsewhere (decrypt the open vault tabs, close an unlock
 * dialog that was waiting) and refresh after another window saved a login. Returns the unsubscribe.
 */
export function initVaultStateSync(self = "main"): () => void {
  let cancelled = false;
  const subs = [
    listen<VaultStateEvent>(VAULT_STATE_EVENT, async (e) => {
      const store = useVaultStore.getState();
      const action = vaultSyncAction(e.payload, store, self);
      if (action === "ignore") return;
      if (action === "locked") { store.setUnlocked(false); return; }
      store.setUnlocked(true);
      if (store.dialog === "unlock") store.finish(true);
      const { useAppStore } = await import("./index"); // lazy: ./index imports this module
      await useAppStore.getState().unlockVaultTabs();
    }),
    listen(VAULT_ENTRIES_EVENT, async () => {
      window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
      if (!useVaultStore.getState().unlocked) return;
      const { useAppStore } = await import("./index");
      await useAppStore.getState().refreshVaultTabs();
    }),
  ];
  subs.forEach((p) => p.catch((err) => console.warn("vault: cross-window sync unavailable", err)));
  return () => {
    if (cancelled) return;
    cancelled = true;
    subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  };
}

export const useVaultStore = create<VaultUiState>((set, get) => ({
  exists: false,
  unlocked: false,
  dialog: null,

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
