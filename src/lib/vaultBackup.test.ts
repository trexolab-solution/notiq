import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
import { defaultBackupName, formatBytes } from "./vaultBackup";

describe("vault backup helpers", () => {
  it("names the file by local date", () => {
    expect(defaultBackupName(new Date(2026, 0, 5))).toBe("notiq-vault-2026-01-05.nqbackup");
  });
  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
