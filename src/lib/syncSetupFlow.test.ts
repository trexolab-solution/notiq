/**
 * Flow-level tests of Vault Sync setup (design/vault-sync-ux-flow.md, acceptance 1–5): every entry point runs the
 * same flow against a fake backend (mocked `invoke`). The vault store, sync store and notifications are real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Fake backend ─────────────────────────────────────────────────────────────

const NOW = Date.now();
const be = {
  provider: null as "gdrive" | null,
  enabled: false,
  localExists: false,
  unlocked: false,
  localItems: 0,
  remote: { exists: false, sameVault: null as boolean | null },
  remoteItems: 0,
  /** sync_connect waits for this to be called. */
  connectGate: null as null | ((ok: boolean) => void),
};
const invoke = vi.fn();
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

const status = () => ({
  configured: true, provider: be.provider, account: be.provider ? "me@gmail.com" : null, enabled: be.enabled,
  state: be.enabled ? "idle" : "off", lastSyncedMs: be.enabled ? NOW : null, lastError: null, pending: false,
  deviceId: "me", deviceName: "DESK",
});
const items = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `e${i}.nqv`, dir: false }));

async function backend(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "vault_default_dir": return "/vault";
    case "vault_set_root": return null;
    case "vault_status": return { exists: be.localExists, unlocked: be.unlocked };
    case "vault_list": if (!be.unlocked) throw "VAULT_LOCKED"; return items(be.localItems);
    case "sync_status": return status();
    case "sync_connect":
      await new Promise<void>((resolve, reject) => { be.connectGate = (ok) => (ok ? resolve() : reject("Google sign-in was cancelled.")); });
      be.provider = "gdrive";
      return status();
    case "sync_remote_info":
      return { exists: be.remote.exists, sameVault: be.localExists && be.remote.exists ? be.remote.sameVault : null };
    case "sync_devices":
      return [
        { id: "me", name: "DESK", lastSeenMs: NOW, thisDevice: true },
        { id: "lap", name: "LAPTOP", lastSeenMs: NOW - 2 * 3600_000, thisDevice: false },
      ];
    case "sync_join": {
      if (be.localExists) throw "A vault already exists on this device.";
      if (!be.remote.exists) throw "NO_REMOTE_VAULT";
      if (args?.password !== "drive-pw") throw "WRONG_PASSWORD";
      Object.assign(be, { localExists: true, unlocked: true, enabled: true, localItems: be.remoteItems });
      be.remote.sameVault = true;
      return null;
    }
    case "sync_adopt_remote": {
      if (args?.remotePassword !== "drive-pw") throw "WRONG_PASSWORD";
      if (!be.unlocked && args?.mode === "import" && !args?.localPassword) throw "VAULT_LOCKED";
      const imported = args?.mode === "import" ? be.localItems : 0;
      Object.assign(be, { unlocked: true, enabled: true, localItems: be.remoteItems + imported });
      be.remote.sameVault = true;
      return { backupPath: "/app/vault-sync-backups/local-vault-1.nqbackup", imported, skipped: 0, renamed: 0 };
    }
    case "sync_enable": {
      if (!be.unlocked) throw "VAULT_LOCKED";
      if (be.remote.exists && be.remote.sameVault === false) throw "REMOTE_VAULT_DIFFERENT";
      const first = !be.remote.exists;
      be.enabled = true;
      be.remote = { exists: true, sameVault: true };
      return first ? { added: 0, updated: 0, removed: 0, conflicts: [] } : { added: 1, updated: 2, removed: 0, conflicts: [] };
    }
    default: return null;
  }
}

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("./vaultDir", () => ({ ensureVaultDir: async () => "/vault", VAULT_DIR_EVENT: "vault:dir-changed" }));
const unlockVaultTabs = vi.fn(async () => {});
vi.mock("../store", () => ({ useAppStore: { getState: () => ({ unlockVaultTabs, refreshVaultTabs: async () => {} }) } }));

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
const win = new EventTarget();
vi.stubGlobal("window", win);

const N = await import("./notifications");
const { useVaultStore } = await import("../store/vaultStore");
const { useSyncStore } = await import("./vaultSync");
const { SYNC_START_SETUP_EVENT } = await import("./syncSetup");
const F = await import("./syncSetupFlow");
const { useSyncSetupStore: S } = F;

// ── Helpers ──────────────────────────────────────────────────────────────────

const view = () => S.getState().view;
const toasts = () => N.getState().history.map((h) => h.message);
const step = async (name: string) => { await vi.waitFor(() => expect(view().step).toBe(name)); };
const signIn = async () => { await vi.waitFor(() => expect(be.connectGate).not.toBeNull()); be.connectGate!(true); };

/** Answers the vault setup / unlock dialog the way the user would (and records which ones opened). */
const dialogsOpened: string[] = [];
let onSetup: (() => void) | null = null;
useVaultStore.subscribe((st, prev) => {
  if (!st.dialog || st.dialog === prev.dialog) return;
  dialogsOpened.push(st.dialog);
  const mode = st.dialog;
  queueMicrotask(() => {
    if (mode === "setup") {
      if (!onSetup) return;
      onSetup();
      Object.assign(be, { localExists: true, unlocked: true });
      useVaultStore.getState().setUnlocked(true);
      useVaultStore.getState().finish(true);
    } else if (mode === "unlock") {
      be.unlocked = true;
      useVaultStore.getState().setUnlocked(true);
      useVaultStore.getState().finish(true);
    }
  });
});

/** UI state every surface reads: vault on, unlocked, sync ON. */
function expectSyncedUi() {
  expect(useVaultStore.getState().exists).toBe(true);
  expect(useVaultStore.getState().unlocked).toBe(true);
  expect(useSyncStore.getState().status?.enabled).toBe(true);
  expect(view().step).toBe("idle");
}

let treeReloads = 0;
win.addEventListener("vault:dir-changed", () => { treeReloads++; });

beforeEach(() => {
  S.getState().cancel();
  Object.assign(be, {
    provider: null, enabled: false, localExists: false, unlocked: false, localItems: 0,
    remote: { exists: false, sameVault: null }, remoteItems: 0, connectGate: null,
  });
  invoke.mockReset();
  invoke.mockImplementation(backend);
  N.__resetForTests();
  useVaultStore.setState({ exists: false, unlocked: false, dialog: null });
  useSyncStore.setState({ status: null, error: null });
  dialogsOpened.length = 0;
  onSetup = null;
  treeReloads = 0;
  unlockVaultTabs.mockClear();
  mem.clear();
});

// ── Acceptance ───────────────────────────────────────────────────────────────

describe("acceptance 1: fresh profile, Drive has a vault → Use my vault from Google Drive → password", () => {
  it("signs in, offers only the password, opens the Drive vault with sync ON, never asks to create a vault", async () => {
    Object.assign(be, { remote: { exists: true, sameVault: null }, remoteItems: 40 });
    const run = F.startSyncSetup(); // sidebar "Use my vault from Google Drive"
    await step("connecting");
    await signIn();
    await step("openDrive");
    await run;
    expect(view()).toEqual({ step: "openDrive", replaceLocal: false });

    await S.getState().submitDrivePassword("nope");
    expect(S.getState().error).toMatch(/Wrong master password/);
    expect(be.localExists).toBe(false); // nothing written
    expect(view().step).toBe("openDrive");

    await S.getState().submitDrivePassword("drive-pw");
    expectSyncedUi();
    expect(toasts()).toContain("Vault ready · synced with LAPTOP");
    expect(dialogsOpened).toEqual([]); // no create-vault prompt anywhere
    expect(unlockVaultTabs).toHaveBeenCalled(); // open vault tabs decrypt
    expect(treeReloads).toBeGreaterThan(0); // sidebar tree reloads
  });

  it("the sidebar card (already connected) opens the Drive vault the same way", async () => {
    Object.assign(be, { provider: "gdrive", remote: { exists: true, sameVault: null } });
    const wrong = await F.openDriveVault("x", false);
    expect(wrong).toEqual({ ok: false, error: expect.stringMatching(/Wrong master password/) });
    expect(await F.openDriveVault("drive-pw", false)).toEqual({ ok: true });
    expect(useVaultStore.getState().exists && useVaultStore.getState().unlocked).toBe(true);
    expect(useSyncStore.getState().status?.enabled).toBe(true);
  });
});

describe("acceptance 2: fresh profile → Settings → Connect (or the title bar's notiq:sync-start-setup)", () => {
  it("reaches the same result without visiting the sidebar", async () => {
    Object.assign(be, { remote: { exists: true, sameVault: null } });
    const stop = F.listenForSetupRequests(win);
    win.dispatchEvent(new CustomEvent(SYNC_START_SETUP_EVENT));
    await step("connecting");
    await signIn();
    await step("openDrive");
    await S.getState().submitDrivePassword("drive-pw");
    expectSyncedUi();
    expect(dialogsOpened).toEqual([]);
    stop();
  });

  it("Cancel while waiting for Google stops waiting and ignores the late answer", async () => {
    Object.assign(be, { remote: { exists: true, sameVault: null } });
    const run = F.startSyncSetup();
    await step("connecting");
    S.getState().cancel();
    expect(view().step).toBe("idle");
    be.connectGate!(true);
    await run;
    expect(view().step).toBe("idle");
    expect(calls("sync_remote_info")).toHaveLength(0);
  });
});

describe("acceptance 3: fresh profile, Drive empty → create vault → sync ON automatically", () => {
  it("offers Create a new vault, then turns sync on with the upload toast and no further question", async () => {
    const run = F.startSyncSetup();
    await signIn();
    await run;
    expect(view().step).toBe("create");

    let sawCreatingFlag = false;
    onSetup = () => { sawCreatingFlag = F.isCreatingForSync(); };
    await S.getState().createVault();
    await vi.waitFor(() => expect(calls("sync_enable")).toHaveLength(1));
    await vi.waitFor(() => expectSyncedUi());
    expect(sawCreatingFlag).toBe(true); // the setup dialog hides the Drive card + post-create question
    expect(F.isCreatingForSync()).toBe(false);
    expect(dialogsOpened).toEqual(["setup"]);
    expect(toasts()).toContain("Your vault is now in Google Drive");
  });
});

describe("acceptance 4: fresh profile → Create vault (empty) → Connect → the Drive vault is offered directly", () => {
  it("replaces the empty local vault from Drive (backup kept), no two-vaults dialog", async () => {
    Object.assign(be, { localExists: true, unlocked: true, localItems: 0, remote: { exists: true, sameVault: false }, remoteItems: 40 });
    const run = F.startSyncSetup();
    await signIn();
    await run;
    expect(view()).toEqual({ step: "openDrive", replaceLocal: true });
    await S.getState().submitDrivePassword("drive-pw");
    expect(calls("sync_adopt_remote")[0][1]).toEqual({ remotePassword: "drive-pw", mode: "backupOnly" });
    expectSyncedUi();
    const hist = N.getState().history.find((h) => h.message.startsWith("Vault ready"));
    expect(hist?.detail).toContain("local-vault-1.nqbackup");
  });

  it("a locked empty vault is unlocked first, then the flow continues by itself", async () => {
    Object.assign(be, { provider: "gdrive", localExists: true, unlocked: false, localItems: 0, remote: { exists: true, sameVault: false } });
    await F.startSyncSetup();
    await step("openDrive");
    expect(dialogsOpened).toEqual(["unlock"]);
    expect(view()).toEqual({ step: "openDrive", replaceLocal: true });
  });
});

describe("acceptance 5: vault with items + a different Drive vault → two-vaults dialog", () => {
  const setup = async () => {
    Object.assign(be, { provider: "gdrive", localExists: true, unlocked: true, localItems: 12, remote: { exists: true, sameVault: false }, remoteItems: 40 });
    await F.startSyncSetup();
    expect(view()).toEqual({ step: "twoVaults", items: 12 });
    expect(S.getState().devices?.length).toBe(2); // "last changed on LAPTOP …"
  };

  it("first choice: adds this PC's items to the Drive vault, backup path in the toast", async () => {
    await setup();
    await S.getState().chooseTwoVaults("import", "wrong");
    expect(S.getState().error).toMatch(/Wrong password/);
    await S.getState().chooseTwoVaults("import", "drive-pw");
    expect(calls("sync_adopt_remote").at(-1)![1]).toEqual({ remotePassword: "drive-pw", mode: "import" });
    expectSyncedUi();
    const t = N.getState().history.find((h) => h.message === "Vault ready · 12 items added");
    expect(t?.detail).toContain("/app/vault-sync-backups/local-vault-1.nqbackup");
  });

  it("second choice: uses the Drive vault only", async () => {
    await setup();
    await S.getState().chooseTwoVaults("backupOnly", "drive-pw");
    expect(calls("sync_adopt_remote").at(-1)![1]).toEqual({ remotePassword: "drive-pw", mode: "backupOnly" });
    expectSyncedUi();
    expect(toasts()).toContain("Vault ready · using the Google Drive vault");
  });

  it("Keep this PC separate changes nothing and leaves sync off", async () => {
    await setup();
    await S.getState().chooseTwoVaults("cancel", "");
    expect(calls("sync_adopt_remote")).toHaveLength(0);
    expect(view().step).toBe("idle");
    expect(be.enabled).toBe(false);
  });
});

describe("the other rows", () => {
  it("row 4: local vault + empty Drive asks once with the item count, then uploads", async () => {
    Object.assign(be, { provider: "gdrive", localExists: true, unlocked: true, localItems: 12 });
    await F.startSyncSetup();
    expect(view()).toEqual({ step: "upload", items: 12 });
    await S.getState().confirmUpload();
    expectSyncedUi();
    expect(toasts()).toContain("Your vault is now in Google Drive");
  });

  it("row 4 from the post-create step (autoUpload): no confirm", async () => {
    Object.assign(be, { provider: "gdrive", localExists: true, unlocked: true, localItems: 0 });
    await F.startSyncSetup({ autoUpload: true });
    await vi.waitFor(() => expectSyncedUi());
    expect(calls("sync_enable")).toHaveLength(1);
  });

  it("row 5: same vault in Drive → silent merge, toast 'Synced · 3 changes'", async () => {
    Object.assign(be, { provider: "gdrive", localExists: true, unlocked: true, localItems: 5, remote: { exists: true, sameVault: true } });
    await F.startSyncSetup();
    expectSyncedUi();
    expect(toasts()).toContain("Synced · 3 changes");
  });

  it("Drive turns out empty while typing the password → Create a new vault", async () => {
    Object.assign(be, { provider: "gdrive", remote: { exists: true, sameVault: null } });
    await F.startSyncSetup();
    be.remote = { exists: false, sameVault: null };
    await S.getState().submitDrivePassword("drive-pw");
    expect(view().step).toBe("create");
  });

  it("a failed Drive check shows the reason with Try again", async () => {
    be.provider = "gdrive";
    invoke.mockImplementation(async (cmd: string, a?: Record<string, unknown>) => {
      if (cmd === "sync_remote_info") throw "SYNC_OFFLINE";
      return backend(cmd, a);
    });
    await F.startSyncSetup();
    expect(view()).toEqual({ step: "error", message: expect.stringMatching(/offline/) });
  });

  it("started from the setup dialog: a caller waiting for the vault continues when the flow ends", async () => {
    Object.assign(be, { provider: "gdrive", remote: { exists: true, sameVault: null } });
    useVaultStore.setState({ dialog: "setup" });
    let resolved: boolean | null = null;
    // A waiter registered the usual way (e.g. opening a locked note).
    const waiting = useVaultStore.getState().ensureUnlocked().then((ok) => { resolved = ok; });
    await vi.waitFor(() => expect(useVaultStore.getState().dialog).toBe("setup"));
    useVaultStore.getState().setDialog(null);
    await F.startSyncSetup({ fromSetup: true });
    await S.getState().submitDrivePassword("drive-pw");
    await waiting;
    expect(resolved).toBe(true);
  });

  it("cancelling a flow started from the setup dialog goes back to the setup dialog (caller still waiting)", async () => {
    Object.assign(be, { provider: "gdrive", remote: { exists: true, sameVault: null } });
    let resolved: boolean | null = null;
    void useVaultStore.getState().ensureUnlocked().then((ok) => { resolved = ok; });
    await vi.waitFor(() => expect(useVaultStore.getState().dialog).toBe("setup"));
    useVaultStore.getState().setDialog(null);
    await F.startSyncSetup({ fromSetup: true });
    expect(view().step).toBe("openDrive");
    S.getState().cancel();
    expect(useVaultStore.getState().dialog).toBe("setup");
    await Promise.resolve();
    expect(resolved).toBeNull();
    useVaultStore.getState().finish(false); // the user cancels the setup dialog too
  });
});
