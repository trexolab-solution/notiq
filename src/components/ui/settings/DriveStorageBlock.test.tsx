// @vitest-environment happy-dom
/** Settings → Vault → Sync, Google Drive storage: formatting, levels, loading / error / unlimited states, no fetch when signed out. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DriveStorageBlock } = await import("./DriveStorageBlock");
const { SyncSection } = await import("./SyncSection");
const { useSyncStore } = await import("../../../lib/vaultSync");
const { useVaultStore } = await import("../../../store/vaultStore");
const { describeStorage, formatStorage } = await import("../../../lib/driveStorage");
type SyncStatus = import("../../../lib/vaultSync").SyncStatus;
type StorageQuota = import("../../../lib/vaultSync").StorageQuota;

const GB = 1024 ** 3;
const base: SyncStatus = {
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: Date.now() - 60_000, lastError: null, pending: false, deviceId: "me0000000000000000000000000000ff", deviceName: "DESK",
};
const quota = (over: Partial<StorageQuota> = {}): StorageQuota => ({
  limit: 15 * GB, usage: 6 * GB, usageInDrive: 2 * GB, usageInDriveTrash: 0, ...over,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  invoke.mockReset();
  useVaultStore.setState({ exists: true, unlocked: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const block = () => document.getElementById("setting-vault.sync.storage")!;
const meter = () => block().querySelector('[role="meter"]');
const button = (name: string) =>
  Array.from(block().querySelectorAll("button")).find((b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name)!;
const fetches = () => invoke.mock.calls.filter((c) => c[0] === "sync_storage_quota").length;
const render = (status: SyncStatus = base) => act(async () => { root.render(<DriveStorageBlock status={status} />); });

describe("formatting", () => {
  it("uses binary units without a trailing .0", () => {
    expect(formatStorage(0)).toBe("0 B");
    expect(formatStorage(1536)).toBe("1.5 KB");
    expect(formatStorage(16_106_127_360)).toBe("15 GB");
    expect(formatStorage(GB - 1)).toBe("1 GB");
    expect(formatStorage(2 * 1024 * GB)).toBe("2 TB");
  });

  it("levels, free space and limits", () => {
    const at = (usage: number, limit = 1000) => describeStorage(quota({ usage, limit }));
    expect(at(849).level).toBe("ok");
    expect(at(850).level).toBe("warning");
    expect(at(950).level).toBe("critical");
    expect(at(999)).toMatchObject({ level: "critical", percent: 99 });
    expect(at(1200)).toMatchObject({ level: "full", percent: 100, free: "0 B free" });
    expect(at(0, 0)).toMatchObject({ level: "full", percent: 100 });
    expect(at(1, 10 * GB).summary).toContain("less than 1%");
    expect(describeStorage(quota({ limit: null }))).toEqual({
      summary: "6 GB used", free: "No storage limit", percent: null, level: "ok",
    });
  });
});

describe("storage block", () => {
  it("loading, then used / total / free with a bar", async () => {
    let release!: (q: StorageQuota) => void;
    invoke.mockImplementation(() => new Promise((r) => { release = r; }));
    await render();
    await act(async () => { await new Promise((r) => setTimeout(r, 250)); }); // InlineLoading waits 200 ms
    expect(block().textContent).toContain("Checking storage…");
    expect(button("Checking storage…").disabled).toBe(true);
    await act(async () => { release(quota({ usageInDriveTrash: GB })); });
    expect(block().textContent).toContain("6 GB of 15 GB used (40%)");
    expect(block().textContent).toContain("9 GB free");
    expect(block().textContent).toContain("Drive files 2 GB (1 GB in trash)");
    expect(meter()!.getAttribute("aria-valuenow")).toBe("40");
    expect(block().querySelector('p[role="status"]')).toBeNull();
  });

  it("warns when nearly full and when full", async () => {
    invoke.mockResolvedValue(quota({ usage: 13 * GB }));
    await render();
    expect(block().querySelector('p[role="status"]')!.textContent).toContain("almost full");
    invoke.mockResolvedValue(quota({ usage: 15 * GB }));
    await act(async () => { button("Refresh storage").click(); });
    expect(block().querySelector('p[role="status"]')!.textContent).toContain("is full");
  });

  it("unlimited accounts get no bar", async () => {
    invoke.mockResolvedValue(quota({ limit: null }));
    await render();
    expect(block().textContent).toContain("6 GB used");
    expect(block().textContent).toContain("No storage limit");
    expect(meter()).toBeNull();
  });

  it("error with Retry; a failed refresh keeps the earlier numbers", async () => {
    invoke.mockRejectedValue("SYNC_OFFLINE");
    await render();
    expect(block().textContent).toContain("Couldn't check storage: You're offline.");
    invoke.mockResolvedValue(quota());
    await act(async () => { button("Retry").click(); });
    expect(block().textContent).toContain("9 GB free");
    expect(block().textContent).not.toContain("Couldn't");
    invoke.mockRejectedValue("Google Drive is having trouble (503). Try again later.");
    await act(async () => { button("Refresh storage").click(); });
    expect(block().textContent).toContain("9 GB free");
    expect(block().textContent).toContain("showing earlier numbers");
    expect(fetches()).toBe(3);
  });

  it("doesn't fetch while Google needs a new sign-in, and does after reconnecting", async () => {
    invoke.mockResolvedValue(quota());
    await render({ ...base, state: "authNeeded" });
    expect(block().textContent).toContain("Reconnect to Google");
    expect(fetches()).toBe(0);
    await render(base);
    expect(fetches()).toBe(1);
  });

  it("checks again when a sync reports a full Drive, not after every sync", async () => {
    invoke.mockResolvedValue(quota());
    await render();
    await render({ ...base, lastSyncedMs: Date.now() });
    expect(fetches()).toBe(1);
    await render({ ...base, state: "error", lastError: "Your Google Drive storage is full." });
    expect(fetches()).toBe(2);
  });
});

describe("in the Sync section", () => {
  async function section(status: SyncStatus) {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "sync_status" ? status : cmd === "sync_devices" ? [] : cmd === "sync_storage_quota" ? quota() : null);
    useSyncStore.setState({ status, error: null });
    await act(async () => { root.render(<SyncSection />); });
  }

  it("shows storage when connected", async () => {
    await section(base);
    expect(block().textContent).toContain("9 GB free");
  });

  it("not connected: no block and no request", async () => {
    await section({ ...base, provider: null, account: null, enabled: false, state: "off" });
    expect(block()).toBeNull();
    expect(fetches()).toBe(0);
  });
});
