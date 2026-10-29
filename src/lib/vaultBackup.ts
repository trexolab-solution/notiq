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
