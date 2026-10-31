import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
const handlers = new Map<string, (e: { payload: unknown }) => void>();
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => { handlers.set(name, cb); return Promise.resolve(unlisten); },
}));

const S = await import("./vaultSync");
const {
  syncStatus, syncConnect, syncDisconnect, syncRemoteInfo, syncEnable, syncJoin, syncAdoptRemote, syncNow, syncDisable,
  syncDevices, syncRemoveDevice, syncSetDeviceName, syncErrorMessage, isSyncError, followSyncStatus, useSyncStore,
  syncIndicator, conflictNotice, relativeTime, deviceNameError, describeSyncResult, ATTACHMENT_LIMITS_TEXT,
  onSyncConflicts, onSyncChanged,
} = S;

const status = (o: Partial<import("./vaultSync").SyncStatus> = {}): import("./vaultSync").SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: null, lastError: null, pending: false, deviceId: "d1", deviceName: "Desk", ...o,
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  handlers.clear();
  unlisten.mockReset();
  useSyncStore.setState({ status: null });
});

describe("command wrappers", () => {
  it("call the contract command names with camelCase args", async () => {
    await syncStatus();
    await syncConnect();
    await syncDisconnect();
    await syncRemoteInfo();
    await syncEnable();
    await syncJoin("pw");
    await syncAdoptRemote("remote", "import");
    await syncAdoptRemote("remote", "import", "local");
    await syncAdoptRemote("remote", "backupOnly");
    await syncNow();
    await syncDisable();
    await syncDevices();
    await syncRemoveDevice("abc");
    await syncSetDeviceName("Laptop");
    expect(invoke.mock.calls).toEqual([
      ["sync_status"],
      ["sync_connect"],
      ["sync_disconnect"],
      ["sync_remote_info"],
      ["sync_enable"],
      ["sync_join", { password: "pw" }],
      ["sync_adopt_remote", { remotePassword: "remote", mode: "import" }],
      ["sync_adopt_remote", { remotePassword: "remote", mode: "import", localPassword: "local" }],
      ["sync_adopt_remote", { remotePassword: "remote", mode: "backupOnly" }],
      ["sync_now"],
      ["sync_disable"],
      ["sync_devices"],
      ["sync_remove_device", { id: "abc" }],
      ["sync_set_device_name", { name: "Laptop" }],
    ]);
  });

  it("pass results through", async () => {
    invoke.mockResolvedValueOnce({ exists: true, sameVault: null });
    await expect(syncRemoteInfo()).resolves.toEqual({ exists: true, sameVault: null });
  });
});

describe("error mapping", () => {
  it("translates every code and passes other messages through", () => {
    for (const code of ["SYNC_NOT_CONFIGURED", "SYNC_NOT_CONNECTED", "SYNC_AUTH", "SYNC_OFFLINE", "REMOTE_VAULT_DIFFERENT",
      "NO_REMOTE_VAULT", "WRONG_PASSWORD", "VAULT_LOCKED"]) {
      const msg = syncErrorMessage(code);
      expect(msg).not.toBe(code);
      expect(msg.length).toBeGreaterThan(5);
    }
    expect(syncErrorMessage("WRONG_PASSWORD")).toBe("Wrong master password");
    expect(syncErrorMessage("Drive quota exceeded")).toBe("Drive quota exceeded");
    expect(syncErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("isSyncError matches the exact code only", () => {
    expect(isSyncError("NO_REMOTE_VAULT", "NO_REMOTE_VAULT")).toBe(true);
    expect(isSyncError("NO_REMOTE_VAULT: x", "NO_REMOTE_VAULT")).toBe(false);
    expect(isSyncError(new Error("WRONG_PASSWORD"), "WRONG_PASSWORD")).toBe(true);
  });
});

describe("status store", () => {
  it("loads sync_status and follows vault-sync://status events", async () => {
    invoke.mockResolvedValueOnce(status({ state: "idle" }));
    const stop = followSyncStatus();
    await vi.waitFor(() => expect(useSyncStore.getState().status?.state).toBe("idle"));
    handlers.get("vault-sync://status")!({ payload: status({ state: "syncing" }) });
    expect(useSyncStore.getState().status?.state).toBe("syncing");
    handlers.get("vault-sync://status")!({ payload: status({ enabled: false, state: "off" }) });
    expect(useSyncStore.getState().status?.enabled).toBe(false);
    stop();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalled();
  });

  it("keeps null when the command is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    invoke.mockRejectedValueOnce("unknown command");
    await expect(useSyncStore.getState().refresh()).resolves.toBeNull();
    expect(useSyncStore.getState().status).toBeNull();
    warn.mockRestore();
  });

  it("conflict / changed listeners unwrap their payloads", async () => {
    const got: unknown[] = [];
    await onSyncConflicts((c) => got.push(c));
    await onSyncChanged(() => got.push("changed"));
    handlers.get("vault-sync://conflicts")!({ payload: { conflicts: [{ path: "a.nqv", fromDevice: "Laptop" }] } });
    handlers.get("vault-sync://conflicts")!({ payload: null });
    handlers.get("vault-sync://changed")!({ payload: {} });
    expect(got).toEqual([[{ path: "a.nqv", fromDevice: "Laptop" }], [], "changed"]);
  });
});

describe("status bar indicator", () => {
  const NOW = 1_000_000_000;
  it("is hidden when sync is off, not connected or unknown", () => {
    expect(syncIndicator(null)).toBeNull();
    expect(syncIndicator(status({ enabled: false, state: "off" }))).toBeNull();
    expect(syncIndicator(status({ provider: null }))).toBeNull();
  });

  it("maps every state", () => {
    const kind = (o: Partial<import("./vaultSync").SyncStatus>) => syncIndicator(status(o), NOW)?.kind;
    expect(kind({ state: "idle" })).toBe("synced");
    expect(kind({ state: "idle", pending: true })).toBe("syncing");
    expect(kind({ state: "syncing" })).toBe("syncing");
    expect(kind({ state: "offline" })).toBe("offline");
    expect(kind({ state: "error", lastError: "Drive said no" })).toBe("problem");
    expect(kind({ state: "authNeeded" })).toBe("problem");
    expect(kind({ state: "locked" })).toBe("locked");
  });

  it("explains itself in the tooltip", () => {
    expect(syncIndicator(status({ state: "idle", lastSyncedMs: NOW - 5 * 60_000 }), NOW)?.tooltip).toContain("5 minutes ago");
    expect(syncIndicator(status({ state: "error", lastError: "Drive said no" }), NOW)?.tooltip).toContain("Drive said no");
    expect(syncIndicator(status({ state: "authNeeded" }), NOW)?.tooltip).toMatch(/sign in again/);
  });
});

describe("conflict notice", () => {
  it("is null without conflicts", () => {
    expect(conflictNotice([])).toBeNull();
  });

  it("counts notes and names the devices once", () => {
    const n = conflictNotice([
      { path: "Work/bank.nqv", fromDevice: "Laptop" },
      { path: "mail.nqv", fromDevice: "Laptop" },
      { path: "wifi.nqv", fromDevice: "Office PC" },
    ])!;
    expect(n.message).toBe("3 notes were edited on two devices; the newer version was kept and the other is in each note's history.");
    expect(n.detail).toContain("Other devices: Laptop, Office PC.");
    expect(n.detail).toContain("Notes: bank, mail, wifi.");
  });

  it("uses the singular for one note", () => {
    const n = conflictNotice([{ path: "bank.nqv", fromDevice: "Laptop" }])!;
    expect(n.message).toBe("1 note was edited on two devices; the newer version was kept and the other is in the note's history.");
    expect(n.detail).toContain("Other device: Laptop.");
  });

  it("caps the list of names", () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ path: `n${i}.nqv`, fromDevice: "X" }));
    expect(conflictNotice(many)!.detail).toContain("and 3 more.");
  });
});

describe("small helpers", () => {
  it("relativeTime", () => {
    const now = 10 * 86_400_000;
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 60_000, now)).toBe("1 minute ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 hours ago");
    expect(relativeTime(now - 86_400_000, now)).toBe("yesterday");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 days ago");
  });

  it("deviceNameError enforces 1–40 characters", () => {
    expect(deviceNameError("  ")).not.toBeNull();
    expect(deviceNameError("a".repeat(41))).not.toBeNull();
    expect(deviceNameError(" Laptop ")).toBeNull();
  });

  it("describeSyncResult", () => {
    expect(describeSyncResult({ added: 0, updated: 0, removed: 0, conflicts: [] })).toBeNull();
    expect(describeSyncResult({ added: 1, updated: 0, removed: 0, conflicts: [] })).toBe("1 change from your other devices");
    expect(describeSyncResult({ added: 1, updated: 2, removed: 1, conflicts: [] })).toBe("4 changes from your other devices");
  });

  it("states the attachment limits", () => {
    expect(ATTACHMENT_LIMITS_TEXT).toBe("Up to 5 MB per file, 25 MB per vault and 20 files per note.");
  });
});
