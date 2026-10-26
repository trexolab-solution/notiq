import { invoke } from "@tauri-apps/api/core";
import { ensureVaultDir } from "./vaultDir";
import { useVaultStore } from "../store/vaultStore";

/** Telegram backup of vault notes — wrappers over the Rust `tg_*` commands. */

export interface TgStatus      { configured: boolean; chat_id: number | null; last_sync: number | null }
export interface SyncReport    { uploaded: number; skipped: number; failed: string[] }
export interface RestoreReport { restored: number; skipped: number; conflicts: number; failed: string[] }
export interface FileState     { rel: string; state: "synced" | "modified" | "new" }

export const TG_EVENT = "telegram:changed";
export const FILE_SAVED_EVENT = "vault:file-saved";

export const tgStatus      = () => invoke<TgStatus>("tg_status");
export const tgDetectChat  = (token: string) => invoke<number>("tg_detect_chat", { token });
export const tgSaveConfig  = (token: string, chatId: number) => invoke<string>("tg_save_config", { token, chatId });
export const tgClear       = () => invoke<void>("tg_clear");
export const tgSyncState   = (root: string) => invoke<FileState[]>("tg_sync_state", { root });
export const tgSync        = (root: string) => invoke<SyncReport>("tg_sync", { root });
export const tgRestore     = (root: string) => invoke<RestoreReport>("tg_restore", { root });

const KEY_AUTO = "pref:tgAutoSync";
export const getTgAutoSync = (): boolean => { try { return localStorage.getItem(KEY_AUTO) === "true"; } catch { return false; } };
export const setTgAutoSync = (v: boolean) => { try { localStorage.setItem(KEY_AUTO, String(v)); } catch { /* unavailable */ } };

const changed = () => window.dispatchEvent(new Event(TG_EVENT));

/** Unlocks if needed, then uploads new/changed notes. Null if the user cancelled. */
export async function runSync(): Promise<SyncReport | null> {
  if (!(await useVaultStore.getState().ensureUnlocked())) return null;
  const rep = await tgSync(await ensureVaultDir());
  changed();
  return rep;
}

export async function runRestore(): Promise<RestoreReport | null> {
  if (!(await useVaultStore.getState().ensureUnlocked())) return null;
  const rep = await tgRestore(await ensureVaultDir());
  changed();
  window.dispatchEvent(new Event("vault:dir-changed")); // refresh the sidebar list
  return rep;
}

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

/**
 * Called just before the vault locks (needs the key). Only when auto-sync is on.
 * Bounded by a timeout so locking is never held up for long; errors are ignored
 * (the note stays safely on disk and syncs next time).
 */
export async function syncBeforeLock(timeoutMs = 8000): Promise<void> {
  if (!getTgAutoSync()) return;
  try {
    if (!(await tgStatus()).configured) return;
    const root = await ensureVaultDir();
    await Promise.race([tgSync(root), new Promise((r) => setTimeout(r, timeoutMs))]);
    changed();
  } catch { /* best effort */ }
}
