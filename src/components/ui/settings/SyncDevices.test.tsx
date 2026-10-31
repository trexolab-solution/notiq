// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DevicesBlock } = await import("./SyncSection");
type SyncStatus = import("../../../lib/vaultSync").SyncStatus;

const RAW_ID = "623dc26ac14b29a54ac147abce02d215";
const status: SyncStatus = {
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: 1, lastError: null, pending: false, deviceId: "me0000000000000000000000000000ff", deviceName: "CODEMUNI",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

describe("Settings → Devices", () => {
  it("shows names with a This PC badge, Unnamed device for unknown names, and never a raw id", async () => {
    invoke.mockImplementation(async (cmd: string) => cmd === "sync_devices" ? [
      { id: status.deviceId, name: "CODEMUNI", lastSeenMs: null, thisDevice: true },
      { id: RAW_ID, name: "", lastSeenMs: Date.now() - 36 * 60_000, thisDevice: false },
      { id: "b".repeat(32), name: "LAPTOP", lastSeenMs: Date.now() - 60_000, thisDevice: false },
    ] : null);
    await act(async () => { root.render(<DevicesBlock status={status} />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const list = document.querySelector('[aria-label="Synced devices"]')!;
    const rows = Array.from(list.querySelectorAll("li")).map((li) => li.textContent);
    expect(rows[0]).toContain("CODEMUNI");
    expect(rows[0]).toContain("This PC");
    expect(rows[1]).toContain("Unnamed device");
    expect(rows[1]).toContain("Last seen 36 minutes ago");
    expect(rows[2]).toContain("LAPTOP");
    expect(document.body.innerHTML).not.toContain(RAW_ID);
    expect(document.querySelector(`[aria-label="Remove Unnamed device"]`)).not.toBeNull();
  });
});
