/**
 * Vault Sync setup flow (0.9.0) — "connecting is the intent to sync". Every entry point (vault sidebar,
 * setup dialog, Settings, the title bar / status bar popover via `notiq:sync-start-setup`, the post-create
 * step) calls `startSyncSetup()`: sign in if needed → check Drive → `decideAfterSignIn` → the one next step →
 * sync ON. The steps are a small store so `SyncSetupHost` only renders them and tests can drive the whole flow
 * with a mocked `invoke`.
 */
import { create } from "zustand";
import { toast } from "./toast";
import { VAULT_CHANGED_EVENT, vaultList } from "./vault";
import {
  syncConnect, syncDevices, syncErrorMessage, syncRemoteInfo, useSyncStore, type SyncDevice,
} from "./vaultSync";
import { HELLO_RESET_NOTE, enableSync, runAdopt, runJoin } from "./vaultSyncFlows";
import { turnOnSyncWithFeedback } from "./syncFeedback";
import { countEntries } from "./syncLifecycle";
import {
  KEPT_SEPARATE_TOAST, PAUSED_TOAST, SYNC_START_SETUP_EVENT, decideAfterSignIn, mergedMessage, sourceDeviceName,
  twoVaultsDoneMessage, vaultReadyMessage, wasSyncedBefore, type LocalVaultFacts,
} from "./syncSetup";
import { useVaultStore } from "../store/vaultStore";

const SOURCE = "Vault sync";
const MERGE_ID = "vault-sync-merge";

// ── Live refresh ─────────────────────────────────────────────────────────────

/**
 * After join / adopt / enable / create: re-read `vault_status` (the backend's own `vault:state-changed` is
 * ignored by the window that ran the command), decrypt open vault tabs if the vault just opened, reload the
 * vault tree and the sync status. Every surface follows these stores, so nothing needs a reload.
 */
export async function refreshVaultUi(): Promise<void> {
  const vault = useVaultStore.getState();
  const wasUnlocked = vault.unlocked;
  await vault.refresh();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
  if (!wasUnlocked && useVaultStore.getState().unlocked) {
    try {
      const { useAppStore } = await import("../store"); // lazy: the app store pulls in most of the app
      await useAppStore.getState().unlockVaultTabs();
    } catch (e) { console.warn("vault sync: couldn't reopen vault tabs", e); }
  }
  await useSyncStore.getState().refresh();
}

/** This PC's vault: exists, unlocked, and how many entries (only readable while unlocked). */
export async function readLocalVault(): Promise<LocalVaultFacts> {
  await useVaultStore.getState().refresh();
  const { exists, unlocked } = useVaultStore.getState();
  let items: number | null = null;
  if (exists && unlocked) {
    try { items = countEntries(await vaultList()); } catch { /* unknown: treated as "has items" */ }
  }
  return { exists, unlocked, items };
}

const loadDevices = async (): Promise<SyncDevice[] | null> => {
  try { return await syncDevices(); } catch { return null; }
};

// ── Opening the Drive vault (rows 1 and 3) — shared by the sidebar card and the setup dialog ──

export type OpenDriveOutcome =
  | { ok: true }
  | { ok: false; error: string }
  /** Drive turned out empty after all. */
  | { ok: false; noRemote: true };

/**
 * The Drive vault's master password → this PC opens it (sync ON). No local vault: `sync_join`. An empty local
 * vault: `sync_adopt_remote(…, "backupOnly")` (a backup of it is kept). Wrong password writes nothing.
 */
export async function openDriveVault(password: string, replaceLocal: boolean, devices?: SyncDevice[] | null): Promise<OpenDriveOutcome> {
  let detail: string | undefined;
  if (!replaceLocal) {
    const out = await runJoin(password);
    if (out.kind === "noRemote") return { ok: false, noRemote: true };
    if (out.kind !== "joined") return { ok: false, error: out.error };
  } else {
    const out = await runAdopt({ choice: "backupOnly", remotePassword: password, localPassword: "", localUnlocked: true });
    if (out.kind === "invalid" || out.kind === "error") return { ok: false, error: out.error };
    if (out.kind === "cancelled") return { ok: false, error: "Cancelled" };
    detail = `The empty vault that was on this PC was saved to ${out.result.backupPath}`;
  }
  await refreshVaultUi();
  const name = sourceDeviceName(devices ?? (await loadDevices()));
  toast.success(vaultReadyMessage(name), { source: SOURCE, detail });
  return { ok: true };
}

// ── The flow ─────────────────────────────────────────────────────────────────

export type SetupView =
  | { step: "idle" }
  | { step: "notConfigured" }
  | { step: "connecting" }
  | { step: "checking" }
  | { step: "openDrive"; replaceLocal: boolean }
  | { step: "create" }
  | { step: "upload"; items: number | null }
  /** Resume found no vault in Drive: "Upload this PC's vault (N items) again?" (row 7). */
  | { step: "reupload"; items: number | null }
  | { step: "twoVaults"; items: number | null }
  | { step: "error"; message: string };

export interface StartOptions {
  /** The user already said "turn on sync" (post-create step): an empty Drive uploads without a confirm. */
  autoUpload?: boolean;
  /** Started from the vault setup dialog: whoever waited for the vault continues when the flow ends. */
  fromSetup?: boolean;
}

interface SetupState {
  view: SetupView;
  /** A command of the current step is running. */
  busy: boolean;
  /** Inline error of the current step (wrong password…). */
  error: string | null;
  account: string | null;
  /** Devices list (names, last seen) for "last changed on LAPTOP, 2 hours ago"; null if unknown. */
  devices: SyncDevice[] | null;
  opts: StartOptions;
  /** "Create your vault" was chosen: sync turns on as soon as the vault exists (no post-create question). */
  pendingCreate: boolean;
  /** This run is a resume on a PC that synced before (`wasSyncedBefore` of the status when it started). */
  wasSynced: boolean;
  start: (opts?: StartOptions) => Promise<void>;
  cancel: () => void;
  retry: () => Promise<void>;
  submitDrivePassword: (password: string) => Promise<void>;
  createVault: () => Promise<void>;
  confirmUpload: () => Promise<void>;
  /** "Not now" / "Cancel" on an upload question: nothing is uploaded, sync stays paused on this PC. */
  declineUpload: () => void;
  chooseTwoVaults: (choice: "import" | "backupOnly" | "cancel", remotePassword: string) => Promise<void>;
  clearError: () => void;
}

/** Each start bumps this; a late answer from an older (cancelled) run is ignored. */
let run = 0;

export const useSyncSetupStore = create<SetupState>((set, get) => {
  const live = (mine: number) => mine === run;

  /**
   * The flow is over: close. Started from the setup dialog → whoever waited for the vault continues once it is
   * open; cancelled before that → back to the setup dialog (still waiting), like a Back button.
   */
  const end = (cancelled = false) => {
    const fromSetup = !!get().opts.fromSetup;
    set({ view: { step: "idle" }, busy: false, error: null, opts: {} });
    if (!fromSetup) return;
    const v = useVaultStore.getState();
    if (cancelled && !v.unlocked) v.setDialog(v.exists ? "unlock" : "setup");
    else v.finish(v.unlocked);
  };

  const fail = (message: string) => set({ view: { step: "error", message }, busy: false, error: null });

  const upload = async (mine: number) => {
    set({ view: { step: "idle" }, busy: false }); // the first-upload toasts take over
    const out = await turnOnSyncWithFeedback();
    if (!live(mine)) return;
    if (out.kind === "different") return showTwoVaults(mine);
    await refreshVaultUi();
    end();
  };

  const showTwoVaults = async (mine: number) => {
    const local = await readLocalVault();
    if (!live(mine)) return;
    set({ view: { step: "twoVaults", items: local.items }, devices: get().devices ?? (await loadDevices()), busy: false, error: null });
  };

  /** After sign-in: check Drive and this PC, then show (or just do) the one next step. */
  const decide = async (mine: number, unlockedOnce = false): Promise<void> => {
    set({ view: { step: "checking" }, busy: false, error: null });
    let remote;
    try { remote = await syncRemoteInfo(); } catch (e) {
      if (live(mine)) fail(syncErrorMessage(e));
      return;
    }
    const local = await readLocalVault();
    if (!live(mine)) return;
    const next = decideAfterSignIn(local, remote, { wasSynced: get().wasSynced });
    switch (next.kind) {
      case "unlock": {
        if (unlockedOnce) return fail("The vault is locked. Unlock it, then try again.");
        set({ view: { step: "idle" } }); // the unlock dialog takes over
        const ok = await useVaultStore.getState().ensureUnlocked();
        if (!live(mine)) return;
        if (!ok) return end();
        return decide(mine, true);
      }
      case "merge": {
        set({ view: { step: "idle" } });
        toast.info("Syncing…", { id: MERGE_ID, duration: 0, source: SOURCE });
        const out = await enableSync();
        toast.remove(MERGE_ID);
        if (!live(mine)) return;
        if (out.kind === "different") return showTwoVaults(mine);
        if (out.kind === "error") return fail(out.error);
        toast.success(mergedMessage(out.result), { source: SOURCE });
        await refreshVaultUi();
        return end();
      }
      case "upload":
        if (get().opts.autoUpload) return upload(mine);
        set({ view: { step: "upload", items: next.items } });
        return;
      case "reupload":
        // Never silently: the Drive vault may have been deleted on purpose.
        set({ view: { step: "reupload", items: next.items } });
        return;
      case "create":
        set({ view: { step: "create" } });
        return;
      case "openDrive": {
        const devices = await loadDevices();
        if (!live(mine)) return;
        set({ view: { step: "openDrive", replaceLocal: next.replaceLocal }, devices });
        return;
      }
      case "twoVaults":
        return showTwoVaults(mine);
    }
  };

  return {
    view: { step: "idle" },
    busy: false,
    error: null,
    account: null,
    devices: null,
    opts: {},
    pendingCreate: false,
    wasSynced: false,

    async start(opts = {}) {
      const mine = ++run;
      set({ view: { step: "checking" }, busy: false, error: null, devices: null, opts, pendingCreate: false, wasSynced: false });
      const status = await useSyncStore.getState().refresh();
      if (!live(mine)) return;
      if (!status) return fail(useSyncStore.getState().error ?? "Couldn't check sync");
      set({ wasSynced: wasSyncedBefore(status) });
      if (!status.configured && !status.provider) { set({ view: { step: "notConfigured" } }); return; }
      if (!status.provider) {
        set({ view: { step: "connecting" } });
        try {
          const s = await syncConnect();
          if (!live(mine)) return; // cancelled: ignore the late answer
          useSyncStore.getState().setStatus(s);
          set({ account: s.account });
        } catch (e) {
          if (live(mine)) fail(syncErrorMessage(e));
          return;
        }
      } else {
        set({ account: status.account });
      }
      await decide(mine);
    },

    cancel() {
      run++;
      set({ pendingCreate: false });
      end(true);
    },

    async retry() { await get().start(get().opts); },

    clearError() { set({ error: null }); },

    async submitDrivePassword(password) {
      const { view, busy, devices } = get();
      if (view.step !== "openDrive" || busy) return;
      const mine = run;
      set({ busy: true, error: null });
      const out = await openDriveVault(password, view.replaceLocal, devices);
      if (!live(mine)) return;
      if (out.ok) return end();
      if ("noRemote" in out) { set({ view: { step: "create" }, busy: false }); return; }
      set({ busy: false, error: out.error });
    },

    async createVault() {
      const mine = run;
      set({ view: { step: "idle" }, pendingCreate: true });
      const ok = await useVaultStore.getState().ensureUnlocked(); // the setup dialog (password, recovery key)
      set({ pendingCreate: false });
      if (!live(mine)) return;
      if (!ok) return end();
      const st = await useSyncStore.getState().refresh();
      if (!live(mine)) return;
      if (st?.enabled) { await refreshVaultUi(); return end(); } // opened from Drive in the setup dialog instead
      set({ opts: { ...get().opts, autoUpload: true } }); // they already said yes: upload without asking again
      await decide(mine);
    },

    async confirmUpload() {
      const step = get().view.step;
      if (step !== "upload" && step !== "reupload") return;
      await upload(run);
    },

    declineUpload() {
      const step = get().view.step;
      if (step !== "upload" && step !== "reupload") return;
      run++;
      toast.info(PAUSED_TOAST, { source: SOURCE });
      end(true);
    },

    async chooseTwoVaults(choice, remotePassword) {
      if (get().view.step !== "twoVaults" || get().busy) return;
      if (choice === "cancel") {
        toast.info(KEPT_SEPARATE_TOAST, { source: SOURCE });
        return end(true);
      }
      const mine = run;
      set({ busy: true, error: null });
      const out = await runAdopt({
        choice, remotePassword, localPassword: "", localUnlocked: useVaultStore.getState().unlocked,
      });
      if (!live(mine)) return;
      if (out.kind !== "done") {
        set({ busy: false, error: out.kind === "cancelled" ? null : out.error });
        return;
      }
      await refreshVaultUi();
      const lines = [`A backup of this PC's vault was saved to ${out.result.backupPath}`];
      if (out.mode === "import" && out.result.renamed) {
        lines.push(`${out.result.renamed} ${out.result.renamed === 1 ? "item differed and was" : "items differed and were"} kept as "Name (This PC)".`);
      }
      lines.push(HELLO_RESET_NOTE);
      toast.success(twoVaultsDoneMessage(out.mode, out.result.imported), { source: SOURCE, detail: lines.join("\n") });
      end();
    },
  };
});

/** Start the setup flow from anywhere (also what `notiq:sync-start-setup` does). */
export const startSyncSetup = (opts?: StartOptions) => useSyncSetupStore.getState().start(opts);

/** The setup dialog was opened by "Create your vault": no Drive card, no post-create question. */
export const isCreatingForSync = () => useSyncSetupStore.getState().pendingCreate;

/** Starts the flow on `notiq:sync-start-setup` (dispatched by the title bar / status bar popover). Returns the unsubscribe. */
export function listenForSetupRequests(target: EventTarget = window): () => void {
  const on = () => { void startSyncSetup(); };
  target.addEventListener(SYNC_START_SETUP_EVENT, on);
  return () => target.removeEventListener(SYNC_START_SETUP_EVENT, on);
}
