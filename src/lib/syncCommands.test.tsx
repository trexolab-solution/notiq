import { describe, expect, it, vi } from "vitest";
import { buildSyncCommands } from "./syncCommands";
import type { SyncStatus } from "./vaultSync";

const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: null, lastError: null, pending: false, deviceId: "d1", deviceName: "Desk", ...o,
});
const h = () => ({ syncNow: vi.fn(), openSettings: vi.fn(), connect: vi.fn() });
const ids = (s: SyncStatus | null, exists = true, unlocked = true) =>
  buildSyncCommands(s, { exists, unlocked }, h()).map((c) => c.id);

describe("palette sync commands", () => {
  it("none without a vault", () => {
    expect(ids(status(), false, false)).toEqual([]);
  });

  it("sync on and unlocked: Sync now + Sync settings", () => {
    expect(ids(status())).toEqual(["vault:sync-now", "vault:sync-settings"]);
  });

  it("locked vault: no Sync now", () => {
    expect(ids(status(), true, false)).toEqual(["vault:sync-settings"]);
    expect(ids(status({ state: "locked" }))).toEqual(["vault:sync-settings"]);
  });

  it("not connected: Connect Google Drive (only in a configured build)", () => {
    const disc = status({ provider: null, account: null, enabled: false, state: "off" });
    expect(ids(disc)).toEqual(["vault:sync-connect", "vault:sync-settings"]);
    expect(ids({ ...disc, configured: false })).toEqual(["vault:sync-settings"]);
  });

  it("connected but off: settings only", () => {
    expect(ids(status({ enabled: false, state: "off" }))).toEqual(["vault:sync-settings"]);
  });

  it("labels and handlers", () => {
    const handlers = h();
    const cmds = buildSyncCommands(status({ provider: null, enabled: false, state: "off" }), { exists: true, unlocked: true }, handlers);
    expect(cmds.map((c) => c.label)).toEqual(["Vault: Connect Google Drive", "Vault: Sync settings"]);
    cmds.forEach((c) => c.run());
    expect(handlers.connect).toHaveBeenCalledOnce();
    expect(handlers.openSettings).toHaveBeenCalledOnce();
    const now = buildSyncCommands(status(), { exists: true, unlocked: true }, handlers)[0];
    expect(now.label).toBe("Vault: Sync now");
    now.run();
    expect(handlers.syncNow).toHaveBeenCalledOnce();
  });
});
