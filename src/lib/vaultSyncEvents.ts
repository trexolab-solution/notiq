import { toast } from "./toast";
import { VAULT_CHANGED_EVENT } from "./vault";
import { conflictNotice, followSyncStatus, onSyncChanged, onSyncConflicts, useSyncStore, type SyncConflict, type SyncStatus } from "./vaultSync";
import { createAuthNeededTracker } from "./syncLifecycle";
import { checkNewDevices, clearAuthNeeded, notifyAuthNeeded } from "./syncFeedback";

/** Shows the single "edited on two PCs" notification for one sync. */
export function notifyConflicts(conflicts: SyncConflict[]): void {
  const n = conflictNotice(conflicts);
  if (!n) return;
  toast.info(n.message, { title: n.title, detail: n.detail, source: "Vault sync" });
}

/**
 * A sync changed local vault data: re-read `vault_status` (join / adopt can create, replace or unlock the vault, and
 * the backend's `vault:state-changed` from a command this window ran is ignored here), refresh the vault tree (the
 * sidebar listens for VAULT_CHANGED_EVENT) and reload open vault tabs. `refreshVaultTabs` skips dirty tabs, so
 * unsaved edits are never replaced.
 */
export async function applyRemoteChanges(): Promise<void> {
  const { useVaultStore } = await import("../store/vaultStore");
  const wasUnlocked = useVaultStore.getState().unlocked;
  await useVaultStore.getState().refresh();
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
  if (!useVaultStore.getState().unlocked) return;
  const { useAppStore } = await import("../store"); // lazy: the app store pulls in most of the app
  if (wasUnlocked) await useAppStore.getState().refreshVaultTabs();
  else await useAppStore.getState().unlockVaultTabs();
}

/** Whether a status change can mean the vault on this PC changed (connected, sync turned on/off). */
export const vaultMayHaveChanged = (s: SyncStatus | null, prev: SyncStatus | null) =>
  !!s && (!prev || s.provider !== prev.provider || s.enabled !== prev.enabled);

/**
 * Lifecycle notifications from the status stream: ONE "sign in again" notice per authNeeded episode, and a
 * new-device check after each sync (lastSyncedMs moved). Returns the unsubscribe.
 */
export function followSyncLifecycle(): () => void {
  const auth = createAuthNeededTracker();
  let lastSynced: number | null | undefined;
  const onStatus = (s: SyncStatus | null) => {
    const a = auth(s);
    if (a === "notify") notifyAuthNeeded();
    else if (a === "clear") clearAuthNeeded();
    if (s?.enabled && s.lastSyncedMs != null && s.lastSyncedMs !== lastSynced) {
      lastSynced = s.lastSyncedMs;
      void checkNewDevices(s);
    }
  };
  onStatus(useSyncStore.getState().status);
  return useSyncStore.subscribe((st, prev) => {
    if (st.status === prev.status) return;
    onStatus(st.status);
    // Sync turned on/off or the account changed: the vault on this PC may be new (join), replaced or unlocked.
    if (vaultMayHaveChanged(st.status, prev.status)) {
      void import("../store/vaultStore").then(({ useVaultStore }) => useVaultStore.getState().refresh()).catch(() => {});
    }
  });
}

/**
 * Main window only: follow the sync status, notify about conflicts and refresh after remote changes.
 * Returns the unsubscribe.
 */
export function initVaultSyncEvents(): () => void {
  const stopStatus = followSyncStatus();
  const stopLifecycle = followSyncLifecycle();
  const subs = [onSyncConflicts(notifyConflicts), onSyncChanged(() => { void applyRemoteChanges(); })];
  subs.forEach((p) => p.catch((err) => console.warn("vault sync: events unavailable", err)));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopStatus();
    stopLifecycle();
    subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  };
}
