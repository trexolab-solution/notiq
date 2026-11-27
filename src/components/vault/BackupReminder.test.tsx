// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

let status: Record<string, unknown> | null = null;
vi.mock("../../lib/vaultSync", () => ({ useSyncStatus: () => status }));
const requestSyncSetup = vi.fn();
vi.mock("../../lib/syncSurfaces", async (orig) => ({
  ...(await orig<typeof import("../../lib/syncSurfaces")>()),
  requestSyncSetup: () => requestSyncSetup(),
}));
vi.mock("../../lib/vaultBackup", () => ({ exportBackupWithDialog: async () => false }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { BackupReminder } = await import("./BackupReminder");
const { useVaultStore } = await import("../../store/vaultStore");

let host: HTMLDivElement;
let root: Root;
const button = (text: string) => [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
const render = () => act(async () => { root.render(<BackupReminder />); });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("pref:vaultFirstSeen", "1"); // a vault that has been here for a long time, never backed up
  status = { configured: true, provider: null, enabled: false, lastSyncedMs: null, state: "off" };
  requestSyncSetup.mockReset();
  useVaultStore.setState({ exists: true, unlocked: true });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("BackupReminder", () => {
  it("offers Connect Google Drive beside Back up now, and starts the set-up", async () => {
    await render();
    expect(button("Back up now")).toBeTruthy();
    await act(async () => { button("Connect Google Drive")!.click(); });
    expect(requestSyncSetup).toHaveBeenCalledTimes(1);
  });

  it("offers only the backup when Drive isn't available or is already connected", async () => {
    status = { configured: false, provider: null, enabled: false, lastSyncedMs: null };
    await render();
    expect(button("Connect Google Drive")).toBeNull();
    expect(button("Back up now")).toBeTruthy();
    status = { configured: true, provider: "gdrive", enabled: false, lastSyncedMs: 5 };
    await render();
    expect(button("Connect Google Drive")).toBeNull();
    expect(button("Back up now")).toBeTruthy();
  });

  it("doesn't say the vault only exists here once it is syncing to Drive", async () => {
    status = { configured: true, provider: "gdrive", enabled: true, lastSyncedMs: 5 };
    await render();
    expect(host.textContent).toBe("");
  });
});
