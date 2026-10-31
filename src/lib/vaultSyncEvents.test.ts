import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => { handlers.set(name, cb); return Promise.resolve(() => {}); },
}));

const vaultState = { unlocked: true };
const refreshVaultTabs = vi.fn(async () => {});
vi.mock("../store/vaultStore", () => ({ useVaultStore: { getState: () => vaultState } }));
vi.mock("../store", () => ({ useAppStore: { getState: () => ({ refreshVaultTabs }) } }));

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
    expect(hist[0].message).toBe("2 notes were edited on two devices; the newer version was kept and the other is in each note's history.");
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

  it("only refreshes the tree while the vault is locked", async () => {
    vaultState.unlocked = false;
    await applyRemoteChanges();
    expect(treeRefreshes).toBe(1);
    expect(refreshVaultTabs).not.toHaveBeenCalled();
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
