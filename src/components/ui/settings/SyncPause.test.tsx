// @vitest-environment happy-dom
/**
 * Settings → Vault → Sync, the pause control (0.9.0 decision 2): a status line + one button, no toggle.
 * "Sync is on · [Pause]" / "Sync is paused on this PC · [Resume sync]".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
const startSyncSetup = vi.fn(async () => {});
vi.mock("../../../lib/syncSetupFlow", async (orig) => ({
  ...(await orig<typeof import("../../../lib/syncSetupFlow")>()),
  startSyncSetup: () => startSyncSetup(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SyncSection, pauseLine, statusLine } = await import("./SyncSection");
const { useSyncStore } = await import("../../../lib/vaultSync");
const { useVaultStore } = await import("../../../store/vaultStore");
type SyncStatus = import("../../../lib/vaultSync").SyncStatus;

const base: SyncStatus = {
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: Date.now() - 60_000, lastError: null, pending: false, deviceId: "me0000000000000000000000000000ff", deviceName: "DESK",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  invoke.mockReset();
  startSyncSetup.mockReset();
  useVaultStore.setState({ exists: true, unlocked: true });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const row = () => document.getElementById("setting-vault.sync.enabled")!;
const buttons = (el: Element) => Array.from(el.querySelectorAll("button")).map((b) => b.textContent?.trim());

async function render(status: SyncStatus) {
  invoke.mockImplementation(async (cmd: string) => (cmd === "sync_status" ? status : cmd === "sync_devices" ? [] : null));
  useSyncStore.setState({ status, error: null });
  await act(async () => { root.render(<SyncSection />); });
}

describe("pause control", () => {
  it("sync on: 'Sync is on' + Pause, no toggle", async () => {
    await render(base);
    const r = row();
    expect(r.textContent).toContain("Sync is on");
    expect(buttons(r)).toEqual(["Pause"]);
    expect(r.querySelector('[role="switch"], input[type="checkbox"]')).toBeNull();
  });

  it("paused: 'Sync is paused on this PC' + Resume sync, which runs the setup flow (it checks Drive first)", async () => {
    await render({ ...base, enabled: false, state: "off" });
    const r = row();
    expect(r.textContent).toContain("Sync is paused on this PC");
    expect(buttons(r)).toEqual(["Resume sync"]);
    await act(async () => { r.querySelector("button")!.click(); });
    expect(startSyncSetup).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls.some((c) => c[0] === "sync_enable")).toBe(false); // never a direct enable
  });

  it("Pause shows Pausing… while sync_disable runs", async () => {
    let release!: () => void;
    await render(base);
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_disable") await new Promise<void>((r) => { release = r; });
      return cmd === "sync_status" ? base : cmd === "sync_devices" ? [] : null;
    });
    const btn = row().querySelector("button")!;
    await act(async () => { btn.click(); });
    expect(btn.textContent).toContain("Pausing…");
    expect(btn.disabled).toBe(true);
    await act(async () => { release(); });
    expect(invoke.mock.calls.some((c) => c[0] === "sync_disable")).toBe(true);
  });

  it("status lines", () => {
    expect(pauseLine({ enabled: true })).toMatch(/^Sync is on · /);
    expect(pauseLine({ enabled: false })).toMatch(/^Sync is paused on this PC · /);
    const now = Date.now();
    expect(statusLine({ ...base, enabled: false, lastSyncedMs: now - 5 * 60_000 }, now)).toBe("Not syncing. Last synced 5 minutes ago.");
    expect(statusLine({ ...base, enabled: false, lastSyncedMs: null }, now)).toBe("Not syncing.");
    expect(statusLine({ ...base, enabled: false, lastError: "Sync was turned off because…" }, now)).toBe("Sync was turned off because…");
  });
});
