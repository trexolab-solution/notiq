import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { recordBackupNow } from "./backupReminder";

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
