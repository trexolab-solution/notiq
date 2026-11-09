import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("./toast", () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a), info: vi.fn(), remove: vi.fn() } }));
const refreshVaultUi = vi.fn(async () => {});
vi.mock("./syncSetupFlow", () => ({ refreshVaultUi: () => refreshVaultUi() }));

const G = await import("./syncDeletionGuard");
const { useSyncStore } = await import("./vaultSync");
type SyncStatus = import("./vaultSync").SyncStatus;
type PendingDeletions = import("./vaultSync").PendingDeletions;

const pending = (o: Partial<PendingDeletions> = {}): PendingDeletions => ({
  removing: 12, remoteLive: 14, titles: ["Bank", "Mail", "Wifi"], reason: "large", backupDir: "C:/app/vault-sync-backups", ...o,
});
const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "awaitingConfirm",
  lastSyncedMs: null, lastError: null, pending: false, deviceId: "d", deviceName: "Desk", pendingDeletions: pending(), ...o,
});

beforeEach(() => {
  invoke.mockReset(); toastSuccess.mockReset(); toastError.mockReset(); refreshVaultUi.mockClear();
  G.useDeletionGuardUi.setState({ dismissedKey: null, busy: null });
  useSyncStore.setState({ status: null, error: null });
});

describe("copy", () => {
  it("title and message", () => {
    expect(G.guardTitle(pending())).toBe("Delete 12 items from Google Drive?");
    expect(G.guardTitle(pending({ removing: 1 }))).toBe("Delete 1 item from Google Drive?");
    expect(G.guardMessage(pending())).toBe("Syncing this PC would remove 12 of the 14 items in your Google Drive, and from your other devices too.");
    expect(G.guardMessage(pending({ reason: "resume" }))).toMatch(/^This is the first sync since sync was resumed on this PC\. /);
  });
  it("lists titles with 'and K more'", () => {
    expect(G.guardTitleLines(pending({ removing: 3 }))).toMatchObject({ titles: ["Bank", "Mail", "Wifi"], more: 0, moreText: null });
    const many = pending({ removing: 20, titles: ["a", "b", "c", "d", "e", "f", "g", "h"] });
    expect(G.guardTitleLines(many)).toMatchObject({ titles: ["a", "b", "c", "d", "e"], more: 15, moreText: "and 15 more" });
  });
  it("backup line", () => {
    expect(G.guardBackupLine(pending())).toBe("A backup of the Google Drive copy is saved to C:/app/vault-sync-backups before anything is deleted.");
  });
});

describe("shouldShowGuard", () => {
  it("shows only while awaiting a decision", () => {
    expect(G.shouldShowGuard(status(), null)).toBe(true);
    expect(G.shouldShowGuard(status({ state: "idle" }), null)).toBe(false);
    expect(G.shouldShowGuard(status({ pendingDeletions: null }), null)).toBe(false);
    expect(G.shouldShowGuard(status({ enabled: false }), null)).toBe(false);
    expect(G.shouldShowGuard(null, null)).toBe(false);
  });
  it("'Decide later' hides it until the counts change", () => {
    const key = G.guardKey(pending());
    expect(G.shouldShowGuard(status(), key)).toBe(false);
    expect(G.shouldShowGuard(status({ pendingDeletions: pending({ removing: 13 }) }), key)).toBe(true);
  });
});

describe("runGuardChoice", () => {
  const result = { added: 0, updated: 0, removed: 0, conflicts: [], join: { restored: 12, keptLocal: 0 } };

  it("apply: calls the command, toasts with the backup path, refreshes", async () => {
    invoke.mockImplementation(async (cmd: string) => cmd === "sync_apply_deletions" ? { backupPath: "C:/b/x", result } : status({ state: "idle", pendingDeletions: null }));
    const out = await G.runGuardChoice("apply");
    expect(out).toMatchObject({ ok: true, choice: "apply", backupPath: "C:/b/x" });
    expect(toastSuccess).toHaveBeenCalledWith("Deleted from Google Drive · backup saved", expect.objectContaining({ detail: "C:/b/x" }));
    expect(invoke.mock.calls.map((c) => c[0])).toContain("sync_status");
    expect(G.useDeletionGuardUi.getState().busy).toBeNull();
  });

  it("restore: toasts the Drive-first message", async () => {
    invoke.mockImplementation(async (cmd: string) => cmd === "sync_restore_from_drive" ? { backupPath: null, result } : status({ state: "idle" }));
    const out = await G.runGuardChoice("restore");
    expect(out.ok).toBe(true);
    expect(toastSuccess).toHaveBeenCalledWith("Restored 12 items from Drive", expect.anything());
    expect(refreshVaultUi).toHaveBeenCalled();
  });

  it("errors become a toast with the friendly text", async () => {
    invoke.mockImplementation(async (cmd: string) => { if (cmd === "sync_apply_deletions") throw "SYNC_OFFLINE"; return status(); });
    const out = await G.runGuardChoice("apply");
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/offline/) });
    expect(toastError).toHaveBeenCalled();
    expect(G.useDeletionGuardUi.getState().busy).toBeNull();
  });
});
