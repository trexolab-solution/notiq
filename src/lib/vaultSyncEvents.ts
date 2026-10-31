import { toast } from "./toast";
import { VAULT_CHANGED_EVENT } from "./vault";
import { conflictNotice, followSyncStatus, onSyncChanged, onSyncConflicts, type SyncConflict } from "./vaultSync";

/** Shows the single "edited on two devices" notification for one sync. */
export function notifyConflicts(conflicts: SyncConflict[]): void {
  const n = conflictNotice(conflicts);
  if (!n) return;
  toast.info(n.message, { title: n.title, detail: n.detail, source: "Vault sync" });
}

/**
 * A sync changed local vault data: refresh the vault tree (the sidebar listens for VAULT_CHANGED_EVENT)
 * and reload open vault tabs. `refreshVaultTabs` skips dirty tabs, so unsaved edits are never replaced.
 */
export async function applyRemoteChanges(): Promise<void> {
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
  const { useVaultStore } = await import("../store/vaultStore");
  if (!useVaultStore.getState().unlocked) return;
  const { useAppStore } = await import("../store"); // lazy: the app store pulls in most of the app
  await useAppStore.getState().refreshVaultTabs();
}

/**
 * Main window only: follow the sync status, notify about conflicts and refresh after remote changes.
 * Returns the unsubscribe.
 */
export function initVaultSyncEvents(): () => void {
  const stopStatus = followSyncStatus();
  const subs = [onSyncConflicts(notifyConflicts), onSyncChanged(() => { void applyRemoteChanges(); })];
  subs.forEach((p) => p.catch((err) => console.warn("vault sync: events unavailable", err)));
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stopStatus();
    subs.forEach((p) => p.then((un) => un()).catch(() => {}));
  };
}
