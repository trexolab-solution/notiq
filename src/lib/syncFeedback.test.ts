import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let handlers: Record<string, () => unknown> = {};
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string) => {
    calls.push(cmd);
    const h = handlers[cmd];
    if (!h) throw new Error(`unexpected ${cmd}`);
    return h();
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
(globalThis as { window?: unknown }).window = new EventTarget();

const N = await import("./notifications");
const { turnOnSyncWithFeedback, checkNewDevices } = await import("./syncFeedback");
const { followSyncLifecycle } = await import("./vaultSyncEvents");
const { useSyncStore } = await import("./vaultSync");
const { SYNC_BANNER_KEY, seenDevicesKey } = await import("./syncLifecycle");
type SyncStatus = import("./vaultSync").SyncStatus;

const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: null, lastError: null, pending: false, deviceId: "me", deviceName: "Desk", ...o,
});
const messages = () => N.getState().history.map((n) => n.message);
const result = { added: 0, updated: 0, removed: 0, conflicts: [] };

beforeEach(() => {
  N.__resetForTests();
  mem.clear();
  calls.length = 0;
  handlers = { sync_status: () => status() };
});

describe("turning sync on", () => {
  it("first upload: shows the entry count while uploading, then 'now in Google Drive'", async () => {
    let during: string[] = [];
    handlers.sync_remote_info = () => ({ exists: false, sameVault: null });
    handlers.vault_list = () => [{ dir: false }, { dir: false }, { dir: true }, { dir: false }];
    handlers.sync_enable = () => { during = messages(); return result; };
    const out = await turnOnSyncWithFeedback();
    expect(out.kind).toBe("enabled");
    expect(during).toContain("Uploading your vault… 3 entries");
    expect(messages()).toEqual(["Your vault is now in Google Drive"]); // the working notice is gone
    expect(mem.get(SYNC_BANNER_KEY)).toBe("done");
  });

  it("normal sync (Drive already has this vault): no upload wording", async () => {
    handlers.sync_remote_info = () => ({ exists: true, sameVault: true });
    handlers.sync_enable = () => ({ ...result, added: 2 });
    await turnOnSyncWithFeedback();
    expect(calls).not.toContain("vault_list");
    expect(messages()).toEqual(["Sync is on. 2 changes from your other devices"]);
  });

  it("different vault in Drive: no toast, the caller opens A/B/C", async () => {
    handlers.sync_remote_info = () => ({ exists: true, sameVault: false });
    handlers.sync_enable = () => { throw "REMOTE_VAULT_DIFFERENT"; };
    expect((await turnOnSyncWithFeedback()).kind).toBe("different");
    expect(messages()).toEqual([]);
  });

  it("errors are shown once", async () => {
    handlers.sync_remote_info = () => { throw "SYNC_OFFLINE"; };
    handlers.sync_enable = () => { throw "SYNC_OFFLINE"; };
    expect((await turnOnSyncWithFeedback()).kind).toBe("error");
    expect(messages()).toEqual(["Couldn't turn on sync"]);
  });
});

describe("status stream", () => {
  it("shows ONE reconnect notification per authNeeded episode, with a Reconnect action", () => {
    const stop = followSyncLifecycle();
    const set = (o: Partial<SyncStatus>) => useSyncStore.getState().setStatus(status(o));
    set({ state: "authNeeded" });
    set({ state: "authNeeded", pending: true });
    set({ state: "authNeeded" });
    const auth = N.getState().history.filter((n) => n.title === "Vault sync paused");
    expect(auth).toHaveLength(1);
    expect(auth[0].actions?.map((a) => a.label)).toEqual(["Reconnect"]);
    set({ state: "idle" });
    expect(N.getState().history.filter((n) => n.title === "Vault sync paused")).toHaveLength(0);
    stop();
  });
});

describe("new devices", () => {
  it("seeds on the first check, then announces a new device once", async () => {
    let devices = [{ id: "me", name: "Desk", lastSeenMs: null, thisDevice: true }, { id: "a", name: "Laptop", lastSeenMs: 1, thisDevice: false }];
    handlers.sync_devices = () => devices;
    await checkNewDevices(status({ lastSyncedMs: 1 }));
    expect(messages()).toEqual([]);
    expect(JSON.parse(mem.get(seenDevicesKey("me@gmail.com"))!)).toEqual(["me", "a"]);
    devices = [...devices, { id: "b", name: "Office PC", lastSeenMs: 2, thisDevice: false }];
    await checkNewDevices(status({ lastSyncedMs: 2 }));
    await checkNewDevices(status({ lastSyncedMs: 3 }));
    expect(messages()).toEqual(["New device: Office PC joined your vault"]);
  });

  it("does nothing while sync is off", async () => {
    handlers.sync_devices = () => [];
    await checkNewDevices(status({ enabled: false }));
    expect(calls).not.toContain("sync_devices");
  });
});
