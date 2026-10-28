import { invoke } from "@tauri-apps/api/core";
import { ensureVaultDir } from "./vaultDir";
import { useVaultStore } from "../store/vaultStore";
import { toast } from "./toast";

/** Telegram backup of vault notes — wrappers over the Rust `tg_*` commands. */

export type Provider = "telegram" | "gdrive";
export interface TgStatus      { configured: boolean; provider: Provider | null; detail: string | null; last_sync: number | null }
export interface SyncReport    { uploaded: number; downloaded: string[]; conflicts: number; skipped: number; failed: string[] }
export interface FileState     { rel: string; state: "synced" | "modified" | "new" }

export const TG_EVENT = "telegram:changed";
export const FILE_SAVED_EVENT = "vault:file-saved";

export const tgStatus      = () => invoke<TgStatus>("sync_status");
export const tgDetectChat  = (token: string) => invoke<number>("tg_detect_chat", { token });
export const tgSaveConfig  = (token: string, chatId: number) => invoke<string>("tg_connect", { token, chatId });
export const gdriveConnect   = () => invoke<string>("gdrive_connect");
export const gdriveBootstrap = () => invoke<void>("gdrive_bootstrap");
export const tgClear       = () => invoke<void>("sync_disconnect");
export const tgSyncState   = (root: string) => invoke<FileState[]>("sync_state", { root });
export const tgSync        = (root: string) => invoke<SyncReport>("sync_run", { root });
export const tgBootstrap   = (token: string, chatId: number) => invoke<void>("tg_bootstrap", { token, chatId });

const KEY_AUTO = "pref:tgAutoSync";
export const getTgAutoSync = (): boolean => { try { return localStorage.getItem(KEY_AUTO) !== "false"; } catch { return true; } };
export const setTgAutoSync = (v: boolean) => { try { localStorage.setItem(KEY_AUTO, String(v)); } catch { /* unavailable */ } };

const changed = () => window.dispatchEvent(new Event(TG_EVENT));

/** Fired after a sync pulled notes, so open tabs and the sidebar can refresh. */
export const PULLED_EVENT = "vault:pulled";

/** Unlocks if needed, then merges with Telegram both ways. Null if the user cancelled. */
export async function runSync(): Promise<SyncReport | null> {
  if (!(await useVaultStore.getState().ensureUnlocked())) return null;
  const rep = await tgSync(await ensureVaultDir());
  changed();
  if (rep.downloaded.length || rep.conflicts) {
    window.dispatchEvent(new Event("vault:dir-changed")); // refresh the sidebar list
    window.dispatchEvent(new Event(PULLED_EVENT));
  }
  return rep;
}

export const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));

/**
 * Called just before the vault locks (needs the key). Only when auto-sync is on.
 * Bounded by a timeout so locking is never held up for long; errors are ignored
 * (the note stays safely on disk and syncs next time).
 */
export async function syncBeforeLock(timeoutMs = 20000): Promise<void> {
  if (!getTgAutoSync()) return;
  try {
    if (!(await tgStatus()).configured) return;
    const root = await ensureVaultDir();
    const rep = await Promise.race([tgSync(root), new Promise<null>((r) => setTimeout(() => r(null), timeoutMs))]);
    changed();
    if (rep?.failed.length) toast.error(failedText(rep.failed));
  } catch (e) {
    toast.error(`Sync before lock failed: ${errText(e)}`);
  }
}

/** Every failed note, not just the first, so nothing stays hidden. */
export const failedText = (failed: string[]) =>
  `Sync: ${failed.length} failed — ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "; …" : ""}`;
