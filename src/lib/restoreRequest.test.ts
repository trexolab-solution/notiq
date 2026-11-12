import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));

import { onRestoreRequest, routeOpenedPath, takePendingRestore } from "./restoreRequest";
import { isBackupPath, BACKUP_EXT } from "./vaultBackup";

beforeEach(() => { takePendingRestore(); });

describe("backup extension", () => {
  it("writes the short .nqb and still reads the old .nqbackup", () => {
    expect(BACKUP_EXT).toBe("nqb");
    expect(isBackupPath("C:/x/notiq-vault-2026-11-12.nqb")).toBe(true);
    expect(isBackupPath("C:/x/old.NQBACKUP")).toBe(true);
    expect(isBackupPath("C:/x/note.md")).toBe(false);
    expect(isBackupPath("C:/x/a.nqbx")).toBe(false);
  });
});

describe("routeOpenedPath", () => {
  it("sends a backup to the restore dialog and leaves other files alone", () => {
    const seen: string[] = [];
    const off = onRestoreRequest((p) => seen.push(p));
    expect(routeOpenedPath("C:/notes/todo.md")).toBe(false);
    expect(routeOpenedPath("C:/b/vault.nqb")).toBe(true);
    off();
    expect(seen).toEqual(["C:/b/vault.nqb"]);
  });
  it("keeps a request that arrives before the dialog host is mounted", () => {
    expect(routeOpenedPath("C:/b/early.nqb")).toBe(true);
    expect(takePendingRestore()).toBe("C:/b/early.nqb");
    expect(takePendingRestore()).toBeNull();
  });
});
