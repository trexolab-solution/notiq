import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { create } from "zustand";
import { ERR_LOCKED, VAULT_ATTACH_MAX_BYTES, VAULT_ATTACH_MAX_PER_NOTE, VAULT_ATTACH_MAX_TOTAL } from "./vault";

/**
 * Vault Sync (0.9.0) — typed wrappers over the Rust `sync_*` commands, their error codes and events,
 * plus a small store that follows the live sync status. The command contract is fixed in
 * design/vault-sync-plan.md (P3 ↔ P4); every network call and token stays in Rust.
 */

// ── Types (JSON is camelCase) ─────────────────────────────────────────────────

export type SyncState = "off" | "idle" | "syncing" | "offline" | "error" | "authNeeded" | "locked";

export interface SyncStatus {
  /** This build has a Google client id (else Connect is disabled with a note). */
  configured: boolean;
  /** null = not connected. */
  provider: "gdrive" | null;
  account: string | null;
  /** Live sync is on for this vault on this device. */
  enabled: boolean;
  /** "off" when !enabled; "locked" when enabled but the vault is locked. */
  state: SyncState;
  lastSyncedMs: number | null;
  /** Human readable, never contains tokens. */
  lastError: string | null;
  /** Local changes not yet uploaded. */
  pending: boolean;
  deviceId: string;
  deviceName: string;
}

export interface SyncDevice { id: string; name: string; lastSeenMs: number | null; thisDevice: boolean }
export interface SyncConflict { path: string; fromDevice: string }
export interface SyncResult { added: number; updated: number; removed: number; conflicts: SyncConflict[] }
export interface RemoteVaultInfo { exists: boolean; sameVault: boolean | null }
export interface AdoptResult { backupPath: string; imported: number; skipped: number; renamed: number }
export type AdoptMode = "import" | "backupOnly";

// ── Error codes (a command rejects with EXACTLY one of these when the UI must branch) ──

export const ERR_SYNC_NOT_CONFIGURED = "SYNC_NOT_CONFIGURED";
export const ERR_SYNC_NOT_CONNECTED = "SYNC_NOT_CONNECTED";
export const ERR_SYNC_AUTH = "SYNC_AUTH";
export const ERR_SYNC_OFFLINE = "SYNC_OFFLINE";
export const ERR_REMOTE_VAULT_DIFFERENT = "REMOTE_VAULT_DIFFERENT";
export const ERR_NO_REMOTE_VAULT = "NO_REMOTE_VAULT";
export const ERR_WRONG_PASSWORD = "WRONG_PASSWORD";
export { ERR_LOCKED };

/** The rejection value as a string (Tauri rejects with a plain string). */
export const errorText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

/** True when the rejection is exactly this code. */
export const isSyncError = (e: unknown, code: string): boolean => errorText(e) === code;

const MESSAGES: Record<string, string> = {
  [ERR_SYNC_NOT_CONFIGURED]: "Sync isn't available in this build of Notiq",
  [ERR_SYNC_NOT_CONNECTED]: "Connect your Google account first",
  [ERR_SYNC_AUTH]: "Google needs you to sign in again. Choose Reconnect.",
  [ERR_SYNC_OFFLINE]: "You're offline. Changes will sync when you're back online.",
  [ERR_REMOTE_VAULT_DIFFERENT]: "Your Google Drive already holds a different vault",
  [ERR_NO_REMOTE_VAULT]: "There's no synced vault in this Google account yet",
  [ERR_WRONG_PASSWORD]: "Wrong master password",
  [ERR_LOCKED]: "The vault is locked",
};

/** Friendly text for any sync rejection: known codes are translated, other messages pass through. */
export function syncErrorMessage(e: unknown): string {
  const s = errorText(e);
  return MESSAGES[s] ?? s;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export const syncStatus = () => invoke<SyncStatus>("sync_status");
/** Opens the browser and waits (up to 180 s) for the Google sign-in. */
export const syncConnect = () => invoke<SyncStatus>("sync_connect");
/** Signs out on this device. Never deletes anything from Drive. */
export const syncDisconnect = () => invoke<void>("sync_disconnect");
export const syncRemoteInfo = () => invoke<RemoteVaultInfo>("sync_remote_info");
export const syncEnable = () => invoke<SyncResult>("sync_enable");
/** New device without a local vault: download the synced vault and open it. */
export const syncJoin = (password: string) => invoke<void>("sync_join", { password });
export const syncAdoptRemote = (remotePassword: string, mode: AdoptMode, localPassword?: string) =>
  invoke<AdoptResult>("sync_adopt_remote", localPassword ? { remotePassword, mode, localPassword } : { remotePassword, mode });
export const syncNow = () => invoke<SyncResult>("sync_now");
export const syncDisable = () => invoke<void>("sync_disable");
export const syncDevices = () => invoke<SyncDevice[]>("sync_devices");
export const syncRemoveDevice = (id: string) => invoke<void>("sync_remove_device", { id });
export const syncSetDeviceName = (name: string) => invoke<SyncStatus>("sync_set_device_name", { name });

export const DEVICE_NAME_MAX = 40;

/** Problem with a device name, or null when it's fine (1–40 characters after trimming). */
export function deviceNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name for this device";
  if (n.length > DEVICE_NAME_MAX) return `Use at most ${DEVICE_NAME_MAX} characters`;
  return null;
}

// ── Events ────────────────────────────────────────────────────────────────────

export const SYNC_STATUS_EVENT = "vault-sync://status";
export const SYNC_CONFLICTS_EVENT = "vault-sync://conflicts";
export const SYNC_CHANGED_EVENT = "vault-sync://changed";

export const onSyncStatus = (cb: (s: SyncStatus) => void): Promise<UnlistenFn> =>
  listen<SyncStatus>(SYNC_STATUS_EVENT, (e) => cb(e.payload));
export const onSyncConflicts = (cb: (c: SyncConflict[]) => void): Promise<UnlistenFn> =>
  listen<{ conflicts: SyncConflict[] }>(SYNC_CONFLICTS_EVENT, (e) => cb(e.payload?.conflicts ?? []));
export const onSyncChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen(SYNC_CHANGED_EVENT, () => cb());

// ── Status store ──────────────────────────────────────────────────────────────

interface SyncStore {
  /** null until the first `sync_status` answered (stays null while the command fails). */
  status: SyncStatus | null;
  /** Why the last `sync_status` failed (friendly text), or null. */
  error: string | null;
  refresh: () => Promise<SyncStatus | null>;
  setStatus: (s: SyncStatus) => void;
}

export const useSyncStore = create<SyncStore>((set) => ({
  status: null,
  error: null,
  async refresh() {
    try {
      const s = await syncStatus();
      set({ status: s, error: null });
      return s;
    } catch (e) {
      console.warn("vault sync: status unavailable", e);
      set({ error: syncErrorMessage(e) || "Couldn't read the sync status" });
      return null;
    }
  },
  setStatus(s) { set({ status: s, error: null }); },
}));

/** Follows `vault-sync://status` into the store. Returns the unsubscribe. */
export function followSyncStatus(): () => void {
  let un: UnlistenFn | null = null;
  let done = false;
  onSyncStatus((s) => useSyncStore.getState().setStatus(s))
    .then((u) => { if (done) u(); else un = u; })
    .catch((err) => console.warn("vault sync: status events unavailable", err));
  void useSyncStore.getState().refresh();
  return () => { done = true; un?.(); };
}

// ── Presentation helpers (pure) ───────────────────────────────────────────────

/** "just now", "5 minutes ago", "yesterday", "3 days ago"; "never" for null. */
export function relativeTime(then: number | null, now: number): string {
  if (then == null) return "never";
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? "1 minute ago" : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? "1 hour ago" : `${h} hours ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  return `${d} days ago`;
}

export type SyncIndicatorKind = "synced" | "syncing" | "offline" | "problem" | "locked";
export interface SyncIndicator { kind: SyncIndicatorKind; label: string; tooltip: string }

/** What the status bar shows for a status; null hides it (sync off, not connected or unknown). */
export function syncIndicator(s: SyncStatus | null, now = Date.now()): SyncIndicator | null {
  if (!s || !s.provider || !s.enabled || s.state === "off") return null;
  const last = `Last synced ${relativeTime(s.lastSyncedMs, now)}`;
  switch (s.state) {
    case "syncing":
      return { kind: "syncing", label: "Syncing", tooltip: "Vault sync: syncing with Google Drive…" };
    case "offline":
      return { kind: "offline", label: "Offline", tooltip: `Vault sync: offline. Changes will sync when you're back online. ${last}.` };
    case "error":
      return { kind: "problem", label: "Sync problem", tooltip: `Vault sync: ${s.lastError ?? "something went wrong"}. Click for details.` };
    case "authNeeded":
      return { kind: "problem", label: "Sync problem", tooltip: "Vault sync: Google needs you to sign in again. Click to reconnect." };
    case "locked":
      return { kind: "locked", label: "Sync paused", tooltip: "Vault sync: paused while the vault is locked." };
    default:
      return s.pending
        ? { kind: "syncing", label: "Waiting to sync", tooltip: `Vault sync: changes waiting to upload. ${last}.` }
        : { kind: "synced", label: "Synced", tooltip: `Vault sync: up to date. ${last}.` };
  }
}

/** A vault path's display name ("Work/bank.nqv" → "bank"). */
export const entryName = (path: string) => (path.split(/[\\/]/).pop() ?? path).replace(/\.nqv$/i, "");

/** The one notification shown after a sync that resolved conflicts. */
export function conflictNotice(conflicts: SyncConflict[]): { title: string; message: string; detail: string } | null {
  const n = conflicts.length;
  if (!n) return null;
  const devices = [...new Set(conflicts.map((c) => c.fromDevice).filter(Boolean))];
  const message = n === 1
    ? "1 note was edited on two devices; the newer version was kept and the other is in the note's history."
    : `${n} notes were edited on two devices; the newer version was kept and the other is in each note's history.`;
  const from = devices.length ? `Other device${devices.length === 1 ? "" : "s"}: ${devices.join(", ")}.` : "";
  const names = conflicts.slice(0, 10).map((c) => entryName(c.path));
  const more = n > names.length ? ` and ${n - names.length} more` : "";
  const detail = [from, `Notes: ${names.join(", ")}${more}.`].filter(Boolean).join("\n");
  return { title: "Vault sync", message, detail };
}

/** One line describing a finished sync ("3 changes from other devices"), or null when nothing changed. */
export function describeSyncResult(r: SyncResult): string | null {
  const n = r.added + r.updated + r.removed;
  if (!n) return null;
  return n === 1 ? "1 change from your other devices" : `${n} changes from your other devices`;
}

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
/** The attachment limits, in words (Settings → Sync and the attachments panel). */
export const ATTACHMENT_LIMITS_TEXT =
  `Up to ${mb(VAULT_ATTACH_MAX_BYTES)} per file, ${mb(VAULT_ATTACH_MAX_TOTAL)} per vault and ${VAULT_ATTACH_MAX_PER_NOTE} files per note.`;

export const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/connections";

/** The live sync status (null until known); loads it the first time a component asks. */
export function useSyncStatus(): SyncStatus | null {
  const status = useSyncStore((s) => s.status);
  useEffect(() => {
    if (useSyncStore.getState().status === null) void useSyncStore.getState().refresh();
  }, []);
  return status;
}
