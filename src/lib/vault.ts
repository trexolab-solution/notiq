import { invoke } from "@tauri-apps/api/core";

/** Secure Vault — thin typed wrappers over the Rust `vault_*` commands. */

export const VAULT_EXT = "nqv";

// Stable error codes emitted by src-tauri/src/vault.rs
export const ERR_NO_VAULT = "NO_VAULT";
export const ERR_LOCKED = "VAULT_LOCKED";

export interface VaultStatus { exists: boolean; unlocked: boolean }
export interface VaultFile   { content: string; ext: string }

export const isVaultPath = (p?: string): boolean => !!p && /\.nqv$/i.test(p);

/** Vault notes are never sent to an AI provider (chat context, actions, autocomplete). */
export const AI_BLOCKED_FOR_VAULT_MSG = "AI is disabled for vault notes to keep them private";

/** Original file type for a plain path ("notes/a.md" → "md"); defaults to "md". */
export function extFromPath(p?: string): string {
  const m = p?.match(/\.([A-Za-z0-9]{1,16})$/);
  return (m ? m[1] : "md").toLowerCase();
}

/**
 * The path the editor should use to decide language / markdown-ness. A `.nqv`
 * tab is shown as if it were the original file type (e.g. `note.nqv` → `note.md`).
 */
export function displayPathOf(tab: { filePath?: string; vaultExt?: string }): string | undefined {
  if (!isVaultPath(tab.filePath)) return tab.filePath;
  return tab.filePath!.replace(/\.nqv$/i, `.${tab.vaultExt ?? "md"}`);
}

export const vaultStatus = () => invoke<VaultStatus>("vault_status");
export const vaultCreate = (password: string) => invoke<string>("vault_create", { password });
export const vaultUnlock = (password: string) => invoke<void>("vault_unlock", { password });
export const vaultUnlockWithRecovery = (recoveryKey: string, newPassword: string) =>
  invoke<void>("vault_unlock_with_recovery", { recoveryKey, newPassword });
export const vaultChangePassword = (oldPassword: string, newPassword: string) =>
  invoke<void>("vault_change_password", { oldPassword, newPassword });
export const vaultLock = () => invoke<void>("vault_lock");
export const vaultWriteFile = (path: string, content: string, ext: string) =>
  invoke<void>("vault_write_file", { path, content, ext }).then(() => {
    window.dispatchEvent(new Event("vault:file-saved"));
  });
export const vaultReadFile = (path: string) => invoke<VaultFile>("vault_read_file", { path });

/** Tauri rejects with a plain string; turn codes into friendly text. */
export function vaultErrorMessage(e: unknown): string {
  const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  if (s === ERR_LOCKED) return "The vault is locked";
  if (s === ERR_NO_VAULT) return "No vault has been set up yet";
  return s;
}
