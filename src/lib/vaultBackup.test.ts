import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
import {
  defaultBackupName, formatBytes, mergeSummary, restoreStep, REPLACE_CONFIRM_WORD, type RestoreForm,
} from "./vaultBackup";

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

const form = (f: Partial<RestoreForm> = {}): RestoreForm => ({
  checked: true, exists: true, unlocked: true, mode: "merge", typed: "", password: "", busy: false, ...f,
});

describe("restoreStep", () => {
  it("with no vault here, restores once the file is checked", () => {
    expect(restoreStep(form({ exists: false }))).toEqual({ canSubmit: true, needsUnlock: false, label: "Restore vault" });
    expect(restoreStep(form({ exists: false, checked: false })).canSubmit).toBe(false);
    expect(restoreStep(form({ exists: false, busy: true })).canSubmit).toBe(false);
  });

  it("replace needs the typed confirmation, never the unlock or a password", () => {
    expect(restoreStep(form({ mode: "replace", unlocked: false })))
      .toEqual({ canSubmit: false, needsUnlock: false, label: "Replace vault" });
    expect(restoreStep(form({ mode: "replace", unlocked: false, typed: REPLACE_CONFIRM_WORD })).canSubmit).toBe(true);
    expect(restoreStep(form({ mode: "replace", typed: "replace" })).canSubmit).toBe(false);
  });

  it("merge needs the vault unlocked and the backup's password", () => {
    expect(restoreStep(form({ unlocked: false, password: "pw" })))
      .toEqual({ canSubmit: false, needsUnlock: true, label: "Merge into vault" });
    expect(restoreStep(form({ password: "" })).canSubmit).toBe(false);
    expect(restoreStep(form({ password: "pw" }))).toEqual({ canSubmit: true, needsUnlock: false, label: "Merge into vault" });
    expect(restoreStep(form({ password: "pw", checked: false })).canSubmit).toBe(false);
    expect(restoreStep(form({ password: "pw", busy: true })).canSubmit).toBe(false);
  });
});

describe("mergeSummary", () => {
  const r = { added: 0, updated: 0, unchanged: 0, kept_in_history: 0, previous_saved_to: null };
  it("counts notes", () => {
    expect(mergeSummary({ ...r, added: 1, unchanged: 3 })).toBe("Added 1 note, updated 0, 3 unchanged.");
    expect(mergeSummary({ ...r, added: 2, updated: 1, kept_in_history: 1 }))
      .toBe("Added 2 notes, updated 1, 0 unchanged, 1 older version kept in history.");
    expect(mergeSummary({ ...r, kept_in_history: 4 })).toContain("4 older versions kept in history");
  });
});
