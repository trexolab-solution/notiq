import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => { handlers.set(name, cb); return Promise.resolve(() => {}); },
}));

const vaultState = { unlocked: true, refresh: vi.fn(async () => {}) };
const refreshVaultTabs = vi.fn(async () => {});
const unlockVaultTabs = vi.fn(async () => {});
vi.mock("../store/vaultStore", () => ({ useVaultStore: { getState: () => vaultState } }));
vi.mock("../store", () => ({ useAppStore: { getState: () => ({ refreshVaultTabs, unlockVaultTabs }) } }));

const win = new EventTarget();
vi.stubGlobal("window", win);

const N = await import("./notifications");
const { VAULT_CHANGED_EVENT } = await import("./vault");
const { initVaultSyncEvents, notifyConflicts, applyRemoteChanges } = await import("./vaultSyncEvents");

let treeRefreshes = 0;
win.addEventListener(VAULT_CHANGED_EVENT, () => { treeRefreshes++; });

beforeEach(() => {
  N.__resetForTests();
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  handlers.clear();
  refreshVaultTabs.mockClear();
  unlockVaultTabs.mockClear();
  vaultState.refresh.mockReset();
  vaultState.refresh.mockImplementation(async () => {});
  treeRefreshes = 0;
  vaultState.unlocked = true;
});

describe("conflict notification", () => {
  it("shows exactly one notification per sync, with the device names", () => {
    notifyConflicts([
      { path: "bank.nqv", fromDevice: "Laptop" },
      { path: "mail.nqv", fromDevice: "Laptop" },
    ]);
    const hist = N.getState().history;
    expect(hist).toHaveLength(1);
    expect(hist[0].message).toBe("2 notes were edited on two PCs. The newer versions are kept, the others are in their history.");
    expect(hist[0].detail).toContain("Laptop");
    expect(hist[0].source).toBe("Vault sync");
  });

  it("shows nothing for an empty list", () => {
    notifyConflicts([]);
    expect(N.getState().history).toHaveLength(0);
  });
});

describe("remote changes", () => {
  it("refreshes the tree and the open vault tabs (dirty tabs are skipped by refreshVaultTabs)", async () => {
    await applyRemoteChanges();
    expect(treeRefreshes).toBe(1);
    expect(refreshVaultTabs).toHaveBeenCalledTimes(1);
  });

  it("re-reads the vault status first, and opens vault tabs when a join/adopt just unlocked the vault", async () => {
    vaultState.unlocked = false;
    vaultState.refresh.mockImplementation(async () => { vaultState.unlocked = true; });
    await applyRemoteChanges();
    expect(vaultState.refresh).toHaveBeenCalledTimes(1);
    expect(treeRefreshes).toBe(1);
    expect(unlockVaultTabs).toHaveBeenCalledTimes(1);
    expect(refreshVaultTabs).not.toHaveBeenCalled();
  });

  it("only refreshes the tree while the vault is locked", async () => {
    vaultState.unlocked = false;
    await applyRemoteChanges();
    expect(treeRefreshes).toBe(1);
    expect(refreshVaultTabs).not.toHaveBeenCalled();
  });
});

describe("vaultMayHaveChanged", () => {
  const st = (o: Record<string, unknown> = {}) => ({
    configured: true, provider: "gdrive", account: "a@b.c", enabled: true, state: "idle", lastSyncedMs: 1,
    lastError: null, pending: false, deviceId: "d", deviceName: "Desk", ...o,
  }) as import("./vaultSync").SyncStatus;
  it("is true when connecting, enabling or pausing; false for ordinary status ticks", async () => {
    const { vaultMayHaveChanged } = await import("./vaultSyncEvents");
    expect(vaultMayHaveChanged(st(), null)).toBe(true);
    expect(vaultMayHaveChanged(st(), st({ provider: null }))).toBe(true);
    expect(vaultMayHaveChanged(st(), st({ enabled: false }))).toBe(true);
    expect(vaultMayHaveChanged(st({ state: "syncing" }), st())).toBe(false);
    expect(vaultMayHaveChanged(null, st())).toBe(false);
  });
});

describe("initVaultSyncEvents", () => {
  it("wires conflicts and changed events", async () => {
    const stop = initVaultSyncEvents();
    await Promise.resolve();
    handlers.get("vault-sync://conflicts")!({ payload: { conflicts: [{ path: "a.nqv", fromDevice: "Office" }] } });
    expect(N.getState().history).toHaveLength(1);
    handlers.get("vault-sync://changed")!({ payload: {} });
    await vi.waitFor(() => expect(refreshVaultTabs).toHaveBeenCalledTimes(1));
    expect(treeRefreshes).toBe(1);
    expect(handlers.has("vault-sync://status")).toBe(true);
    stop();
  });
});
