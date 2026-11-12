import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));
import {
  checkDroppedBackup, defaultBackupName, formatBytes, initialRestoreWizard, mergeSummary, restoreStep, restoreWizardReducer,
  REPLACE_CONFIRM_WORD, type RestoreForm, type RestoreWizardAction,
} from "./vaultBackup";

describe("vault backup helpers", () => {
  it("names the file by local date", () => {
    expect(defaultBackupName(new Date(2026, 0, 5))).toBe("notiq-vault-2026-01-05.nqb");
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

describe("restoreWizardReducer", () => {
  const info = { ok: true, vault_id_hex: "ab", db_bytes: 2048, created: 1_700_000_000 };
  const run = (...actions: RestoreWizardAction[]) => actions.reduce(restoreWizardReducer, initialRestoreWizard);
  const checked = (path = "C:/b.nqbackup") => run({ type: "choose", path }, { type: "checked", path, info });

  it("can't leave the file step until the chosen file checks out", () => {
    expect(run({ type: "next", exists: true, unlocked: true }).step).toBe("file");
    const checking = run({ type: "choose", path: "C:/b.nqbackup" });
    expect(checking.checking).toBe(true);
    expect(restoreWizardReducer(checking, { type: "next", exists: true, unlocked: true }).step).toBe("file");
    const failed = restoreWizardReducer(checking, { type: "checkFailed", path: "C:/b.nqbackup", error: "Not a backup" });
    expect(failed.fileError).toBe("Not a backup");
    expect(restoreWizardReducer(failed, { type: "next", exists: true, unlocked: true }).step).toBe("file");
    expect(restoreWizardReducer(checked(), { type: "next", exists: true, unlocked: true }).step).toBe("method");
  });

  it("ignores the result of a check for a file that is no longer chosen", () => {
    const w = run({ type: "choose", path: "C:/old.nqbackup" }, { type: "choose", path: "C:/new.nqbackup" },
      { type: "checked", path: "C:/old.nqbackup", info });
    expect(w.info).toBeNull();
    expect(w.checking).toBe(true);
  });

  it("skips the method step when no vault exists here, both ways", () => {
    const w = restoreWizardReducer(checked(), { type: "next", exists: false, unlocked: false });
    expect(w.step).toBe("confirm");
    expect(restoreWizardReducer(w, { type: "back", exists: false }).step).toBe("file");
  });

  it("needs the vault unlocked to go on with Merge, not with Replace", () => {
    const m = restoreWizardReducer(checked(), { type: "next", exists: true, unlocked: false });
    expect(restoreWizardReducer(m, { type: "next", exists: true, unlocked: false }).step).toBe("method");
    expect(restoreWizardReducer(m, { type: "next", exists: true, unlocked: true }).step).toBe("confirm");
    const r = restoreWizardReducer(m, { type: "mode", mode: "replace" });
    expect(restoreWizardReducer(r, { type: "next", exists: true, unlocked: false }).step).toBe("confirm");
  });

  it("keeps the entered state going back, but clears the password at the file step", () => {
    let w = checked();
    w = restoreWizardReducer(w, { type: "next", exists: true, unlocked: true });
    w = restoreWizardReducer(w, { type: "next", exists: true, unlocked: true });
    w = restoreWizardReducer(w, { type: "password", value: "secret" });
    w = restoreWizardReducer(w, { type: "back", exists: true });
    expect(w.step).toBe("method");
    expect(w.password).toBe("secret");
    expect(w.mode).toBe("merge");
    w = restoreWizardReducer(w, { type: "back", exists: true });
    expect(w.step).toBe("file");
    expect(w.password).toBe("");
    expect(w.path).toBe("C:/b.nqbackup");
    expect(w.info).toBe(info);
  });

  it("stays on confirm after a failure and goes to done with the result", () => {
    let w = checked();
    w = restoreWizardReducer(w, { type: "next", exists: true, unlocked: true });
    w = restoreWizardReducer(w, { type: "next", exists: true, unlocked: true });
    w = restoreWizardReducer(w, { type: "failed", error: "Wrong" });
    expect(w.step).toBe("confirm");
    expect(w.error).toBe("Wrong");
    expect(restoreWizardReducer(w, { type: "password", value: "x" }).error).toBeNull();
    const merged = { added: 1, updated: 0, unchanged: 0, kept_in_history: 0, previous_saved_to: null };
    const done = restoreWizardReducer(w, { type: "merged", result: merged });
    expect(done.step).toBe("done");
    expect(done.hadVault).toBe(true);
    expect(restoreWizardReducer(done, { type: "back", exists: true })).toBe(done);
  });
});

describe("checkDroppedBackup", () => {
  const file = async () => false;
  it("accepts exactly one .nqbackup file", async () => {
    expect(await checkDroppedBackup(["C:/x/notiq.NQBACKUP"], file)).toEqual({ path: "C:/x/notiq.NQBACKUP" });
  });
  it("refuses several items, folders and other file types", async () => {
    expect(await checkDroppedBackup(["C:/a.nqbackup", "C:/b.nqbackup"], file)).toEqual({ error: expect.stringMatching(/one backup file/) });
    expect(await checkDroppedBackup(["C:/backups"], async () => true)).toEqual({ error: expect.stringMatching(/is a folder/) });
    expect(await checkDroppedBackup(["C:/notes.md"], file)).toEqual({ error: expect.stringMatching(/isn't a Notiq backup/) });
  });
  it("leaves a failing stat to the backup check", async () => {
    expect(await checkDroppedBackup(["C:/a.nqbackup"], async () => { throw new Error("denied"); })).toEqual({ path: "C:/a.nqbackup" });
  });
});
