// @vitest-environment happy-dom
/**
 * Settings → Vault → Sync, the Disconnect dialog: plain "Disconnect" keeps the vault on this PC; ticking
 * "Also remove the vault from this PC" removes it (after the newest changes are uploaded, which the backend checks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
const refreshVaultUi = vi.fn(async () => {});
vi.mock("../../../lib/syncSetupFlow", async (orig) => ({
  ...(await orig<typeof import("../../../lib/syncSetupFlow")>()),
  refreshVaultUi: () => refreshVaultUi(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SyncSection, REMOVE_LOCAL_LABEL } = await import("./SyncSection");
const { useSyncStore } = await import("../../../lib/vaultSync");
const { useVaultStore } = await import("../../../store/vaultStore");
type SyncStatus = import("../../../lib/vaultSync").SyncStatus;

const status: SyncStatus = {
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: Date.now() - 60_000, lastError: null, pending: false, deviceId: "me0000000000000000000000000000ff", deviceName: "DESK",
};

let host: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  invoke.mockReset();
  refreshVaultUi.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "sync_status" ? status : cmd === "sync_devices" ? [] : null));
  useVaultStore.setState({ exists: true, unlocked: true });
  useSyncStore.setState({ status, error: null });
  await act(async () => { root.render(<SyncSection />); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const open = async () => { await act(async () => { button("Disconnect…")!.click(); }); };
const calls = () => invoke.mock.calls.map((c) => c[0]);

describe("disconnect dialog", () => {
  it("offers removing the vault, off by default; plain Disconnect keeps the vault", async () => {
    await open();
    const dialog = document.querySelector("[role=alertdialog]")!;
    expect(dialog.textContent).toContain(REMOVE_LOCAL_LABEL);
    const box = dialog.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => { button("Disconnect")!.click(); });
    expect(calls()).toContain("sync_disconnect");
    expect(calls()).not.toContain("sync_disconnect_and_remove_vault");
    expect(refreshVaultUi).not.toHaveBeenCalled();
  });

  it("with the box ticked the button says so, and the vault is removed", async () => {
    await open();
    const box = document.querySelector("[role=alertdialog] input[type=checkbox]") as HTMLInputElement;
    await act(async () => { box.click(); });
    expect(button("Disconnect and remove")).toBeTruthy();
    await act(async () => { button("Disconnect and remove")!.click(); });
    expect(calls()).toContain("sync_disconnect_and_remove_vault");
    expect(calls()).not.toContain("sync_disconnect");
    expect(refreshVaultUi).toHaveBeenCalled();
  });

  it("cancelling does nothing", async () => {
    await open();
    await act(async () => { button("Cancel")!.click(); });
    expect(calls()).not.toContain("sync_disconnect");
    expect(calls()).not.toContain("sync_disconnect_and_remove_vault");
    expect(document.querySelector("[role=alertdialog]")).toBeNull();
  });

  it("when the removal fails the vault stays and the user is not told it was removed", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_disconnect_and_remove_vault") throw "Some changes aren't in Google Drive yet. Sync again, then try once more.";
      return cmd === "sync_status" ? status : cmd === "sync_devices" ? [] : null;
    });
    await open();
    const box = document.querySelector("[role=alertdialog] input[type=checkbox]") as HTMLInputElement;
    await act(async () => { box.click(); });
    await act(async () => { button("Disconnect and remove")!.click(); });
    expect(refreshVaultUi).not.toHaveBeenCalled();
  });
});
