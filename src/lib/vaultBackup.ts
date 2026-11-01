import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { stat } from "@tauri-apps/plugin-fs";
import { recordBackupNow } from "./backupReminder";
import { getFileExtension, getFileName } from "./pathUtils";
import { stepperReducer, type StepperFlow } from "./stepper";

/** Backup export / restore — wrappers over the Rust `vault_backup_*` commands (vault_backup.rs). */

export const BACKUP_EXT = "nqbackup";

export interface BackupExportResult { bytes: number; entries_hint: number | null }
export interface BackupInspect { ok: boolean; vault_id_hex: string; db_bytes: number; created: number | null }
export interface BackupImportResult {
  vault_id_hex: string; db_bytes: number; replaced: boolean; previous_saved_to: string | null;
}

export const vaultVerifyPassword = (password: string) => invoke<void>("vault_verify_password", { password });
export const vaultBackupExport = (destPath: string) => invoke<BackupExportResult>("vault_backup_export", { destPath });
export const vaultBackupInspect = (path: string) => invoke<BackupInspect>("vault_backup_inspect", { path });
export const vaultBackupImport = (path: string, replace: boolean) =>
  invoke<BackupImportResult>("vault_backup_import", { path, replace });

/** What merging a backup did, counted in notes (vault_db::BackupMerge). */
export interface BackupMergeResult {
  added: number; updated: number; unchanged: number; kept_in_history: number; previous_saved_to: string | null;
}
/** Merges a backup into the unlocked vault; `password` is the backup's master password. */
export const vaultBackupMerge = (path: string, password: string) =>
  invoke<BackupMergeResult>("vault_backup_merge", { path, password });

/** With a vault already here: merge the backup into it, or replace it with the backup. */
export type RestoreMode = "merge" | "replace";
export const REPLACE_CONFIRM_WORD = "REPLACE";

export interface RestoreForm {
  /** A backup file was picked and checked. */
  checked: boolean;
  exists: boolean;
  unlocked: boolean;
  mode: RestoreMode;
  typed: string;
  password: string;
  busy: boolean;
}

/** What the restore dialog offers for the current form. */
export function restoreStep(f: RestoreForm): { canSubmit: boolean; needsUnlock: boolean; label: string } {
  if (!f.exists) return { canSubmit: f.checked && !f.busy, needsUnlock: false, label: "Restore vault" };
  if (f.mode === "replace") {
    return { canSubmit: f.checked && !f.busy && f.typed === REPLACE_CONFIRM_WORD, needsUnlock: false, label: "Replace vault" };
  }
  const needsUnlock = !f.unlocked;
  return { canSubmit: f.checked && !f.busy && !needsUnlock && f.password.length > 0, needsUnlock, label: "Merge into vault" };
}

// ── Restore dialog: steps ─────────────────────────────────────────────────────

export type RestoreStepKey = "file" | "method" | "confirm" | "done";
export const RESTORE_STEPS: readonly RestoreStepKey[] = ["file", "method", "confirm", "done"];
export const RESTORE_STEP_LABELS: Record<RestoreStepKey, string> = { file: "File", method: "Method", confirm: "Confirm", done: "Done" };

/** With no vault here there is nothing to merge into or replace: the method step is skipped. */
export const restoreFlow = (exists: boolean): StepperFlow<RestoreStepKey> =>
  ({ steps: RESTORE_STEPS, skipped: exists ? [] : ["method"] });

export interface RestoreWizard {
  step: RestoreStepKey;
  /** The chosen file (being checked, checked, or failed the check). */
  path: string | null;
  info: BackupInspect | null;
  checking: boolean;
  /** Why the chosen file can't be restored (shown on its card). */
  fileError: string | null;
  /** Why a dropped item was refused (the previous choice, if any, stays). */
  dropError: string | null;
  mode: RestoreMode;
  typed: string;
  password: string;
  /** Why the restore itself failed (shown on the confirm step). */
  error: string | null;
  merged: BackupMergeResult | null;
  restored: BackupImportResult | null;
  /** Whether a vault existed when the restore ran (the Done step keeps that flow's steps). */
  hadVault: boolean;
}

export const initialRestoreWizard: RestoreWizard = {
  step: "file", path: null, info: null, checking: false, fileError: null, dropError: null,
  mode: "merge", typed: "", password: "", error: null, merged: null, restored: null, hadVault: false,
};

export type RestoreWizardAction =
  | { type: "choose"; path: string }
  | { type: "checked"; path: string; info: BackupInspect }
  | { type: "checkFailed"; path: string; error: string }
  | { type: "dropRefused"; error: string }
  | { type: "mode"; mode: RestoreMode }
  | { type: "typed"; value: string }
  | { type: "password"; value: string }
  | { type: "next"; exists: boolean; unlocked: boolean }
  | { type: "back"; exists: boolean }
  | { type: "failed"; error: string }
  | { type: "merged"; result: BackupMergeResult }
  | { type: "restored"; result: BackupImportResult; exists: boolean };

/** Whether the wizard's current step is complete (Next enabled). The confirm step uses `restoreStep`. */
export function restoreCanAdvance(w: RestoreWizard, ctx: { exists: boolean; unlocked: boolean }): boolean {
  if (w.step === "file") return !!w.info && !w.checking && !w.fileError;
  if (w.step === "method") return w.mode === "replace" || ctx.unlocked;
  return false;
}

/** The restore dialog's state machine; the dialog only runs the commands and dispatches their results. */
export function restoreWizardReducer(w: RestoreWizard, a: RestoreWizardAction): RestoreWizard {
  switch (a.type) {
    case "choose":
      return { ...w, path: a.path, info: null, checking: true, fileError: null, dropError: null, error: null, password: "", typed: "" };
    case "checked":
      return a.path === w.path ? { ...w, info: a.info, checking: false } : w;
    case "checkFailed":
      return a.path === w.path ? { ...w, info: null, checking: false, fileError: a.error } : w;
    case "dropRefused":
      return { ...w, dropError: a.error };
    case "mode":
      return { ...w, mode: a.mode, error: null };
    case "typed":
      return { ...w, typed: a.value };
    case "password":
      return { ...w, password: a.value, error: null };
    case "next": {
      const step = stepperReducer(restoreFlow(a.exists), w.step, { type: "next", canAdvance: restoreCanAdvance(w, a) });
      return step === w.step ? w : { ...w, step, error: null, dropError: null };
    }
    case "back": {
      if (w.step === "done") return w;
      const step = stepperReducer(restoreFlow(a.exists), w.step, { type: "back" });
      if (step === w.step) return w;
      // Back at the file step: don't keep a password around for a file that may change.
      return { ...w, step, error: null, ...(step === "file" ? { password: "" } : {}) };
    }
    case "failed":
      return { ...w, error: a.error };
    case "merged":
      return { ...w, step: "done", merged: a.result, password: "", error: null, hadVault: true };
    case "restored":
      return { ...w, step: "done", restored: a.result, password: "", typed: "", error: null, hadVault: a.exists };
  }
}

/**
 * Checks what was dropped on the restore dialog: exactly one `.nqbackup` file, not a folder. Returns the
 * path or the message to show. `isDir` defaults to the file system; a failing stat is left to the
 * backup check that follows.
 */
export async function checkDroppedBackup(
  paths: string[],
  isDir: (p: string) => Promise<boolean> = async (p) => (await stat(p)).isDirectory,
): Promise<{ path: string } | { error: string }> {
  if (paths.length === 0) return { error: "Nothing was dropped." };
  if (paths.length > 1) return { error: `Drop one backup file at a time (you dropped ${paths.length} items).` };
  const path = paths[0];
  let dir = false;
  try { dir = await isDir(path); } catch { /* vaultBackupInspect reports it */ }
  if (dir) return { error: `"${getFileName(path)}" is a folder. Drop the .${BACKUP_EXT} file itself.` };
  if (getFileExtension(path) !== BACKUP_EXT) {
    return { error: `"${getFileName(path)}" isn't a Notiq backup. Choose a .${BACKUP_EXT} file.` };
  }
  return { path };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Added 2 notes, updated 1, 3 unchanged, 1 older version kept in history." */
export function mergeSummary(r: BackupMergeResult): string {
  const parts = [`Added ${plural(r.added, "note")}`, `updated ${r.updated}`, `${r.unchanged} unchanged`];
  if (r.kept_in_history) parts.push(`${plural(r.kept_in_history, "older version")} kept in history`);
  return `${parts.join(", ")}.`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `notiq-vault-YYYY-MM-DD.nqbackup` */
export function defaultBackupName(d = new Date()): string {
  return `notiq-vault-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.${BACKUP_EXT}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Asks where to save, exports, and records the time. Null if the user cancelled the save dialog. */
export async function exportBackupWithDialog(): Promise<BackupExportResult | null> {
  const dest = await save({
    title: "Save encrypted vault backup",
    defaultPath: defaultBackupName(),
    filters: [{ name: "Notiq vault backup", extensions: [BACKUP_EXT] }],
  });
  if (!dest) return null;
  const path = new RegExp(`\\.${BACKUP_EXT}$`, "i").test(dest) ? dest : `${dest}.${BACKUP_EXT}`;
  const res = await vaultBackupExport(path);
  recordBackupNow();
  return res;
}

/** Lets the user pick a backup file; null if cancelled. */
export async function pickBackupFile(): Promise<string | null> {
  const sel = await open({
    title: "Choose a Notiq vault backup",
    multiple: false,
    filters: [{ name: "Notiq vault backup", extensions: [BACKUP_EXT] }],
  });
  return typeof sel === "string" ? sel : null;
}
