/**
 * Vault Sync lifecycle feedback (effects): turning sync on with first-upload progress, the single
 * "sign in again" notification with Reconnect, and "New device … joined your vault". The decisions are
 * pure functions in ./syncLifecycle; this file only wires them to commands and notifications.
 */
import { toast } from "./toast";
import { vaultList } from "./vault";
import {
  syncConnect, syncDevices, syncErrorMessage, syncRemoteInfo, describeSyncResult, useSyncStore,
  type SyncStatus,
} from "./vaultSync";
import { enableSync, type EnableOutcome } from "./vaultSyncFlows";
import {
  FIRST_UPLOAD_DONE, countEntries, diffNewDevices, isFirstUpload, loadSeenDevices, markSyncBannerDone,
  newDeviceMessage, saveSeenDevices, seenDevicesKey, uploadingMessage,
} from "./syncLifecycle";

const SOURCE = "Vault sync";
const WORKING_ID = "vault-sync-enable";
const AUTH_ID = "vault-sync-auth";
const CONNECT_ID = "vault-sync-connect";

/**
 * `sync_enable` with feedback: "Uploading your vault… N entries" (first upload) or "Turning on sync…",
 * then "Your vault is now in Google Drive" / "Sync is on…" or an error. The vault must already be unlocked.
 * Returns the outcome so the caller can open the A/B/C dialog on `different`.
 */
export async function turnOnSyncWithFeedback(): Promise<EnableOutcome> {
  let first = false;
  try { first = isFirstUpload(await syncRemoteInfo()); } catch { /* unknown: generic feedback */ }
  let entries: number | null = null;
  if (first) {
    try { entries = countEntries(await vaultList()); } catch { /* message without a count */ }
  }
  toast.info(first ? uploadingMessage(entries) : "Turning on sync…", { id: WORKING_ID, duration: 0, source: SOURCE });
  const out = await enableSync();
  toast.remove(WORKING_ID);
  if (out.kind === "enabled") {
    markSyncBannerDone();
    if (first) toast.success(FIRST_UPLOAD_DONE, { source: SOURCE, detail: "Turn on sync on your other PCs, or choose \"Use my vault from Google Drive\" when you set up the vault there." });
    else toast.success(`Sync is on. ${describeSyncResult(out.result) ?? "Your vault is up to date."}`, { source: SOURCE });
  } else if (out.kind === "error") {
    toast.error("Couldn't turn on sync", { source: SOURCE, detail: out.error });
  }
  return out;
}

// ── Reconnect from a notification (no component to host useSyncConnect) ─────

let connectAttempt = 0;

/** Google sign-in driven from a notification: "Waiting for Google…" with Cancel, then the result. */
export async function reconnectFromNotification(): Promise<void> {
  const mine = ++connectAttempt;
  toast.remove(AUTH_ID);
  toast.info("Waiting for Google sign-in in your browser…", {
    id: CONNECT_ID, duration: 0, source: SOURCE,
    actions: [{ label: "Cancel", onClick: () => { connectAttempt++; toast.remove(CONNECT_ID); } }],
  });
  try {
    const s = await syncConnect();
    if (mine !== connectAttempt) return; // cancelled: ignore the late answer
    useSyncStore.getState().setStatus(s);
    toast.remove(CONNECT_ID);
    toast.success(`Reconnected to Google Drive${s.account ? ` as ${s.account}` : ""}`, { source: SOURCE });
  } catch (e) {
    if (mine !== connectAttempt) return; // cancelled: the user chose not to; don't nag again
    toast.remove(CONNECT_ID);
    // Never leave the user stuck: the paused notice comes back with Reconnect and why it failed.
    notifyAuthNeeded(syncErrorMessage(e));
  }
}

/**
 * The single "Vault sync paused" notice with Reconnect. `failure` (why the last reconnect failed) is shown
 * as its detail when it is re-shown after a failed attempt.
 */
export function notifyAuthNeeded(failure?: string): void {
  toast.warning(
    failure ? "Couldn't reconnect to Google Drive. Try again to keep your vault in sync." : "Google needs you to sign in again to keep your vault in sync.",
    {
      id: AUTH_ID, duration: 0, title: "Vault sync paused", source: SOURCE,
      ...(failure ? { detail: failure } : {}),
      actions: [{ label: "Reconnect", primary: true, onClick: () => { void reconnectFromNotification(); } }],
    },
  );
}

export const clearAuthNeeded = () => toast.remove(AUTH_ID);

// ── New devices ──────────────────────────────────────────────────────────────

let checking = false;

/** After a sync: announce devices that joined since the last check (the first check only seeds). */
export async function checkNewDevices(status: SyncStatus): Promise<void> {
  if (checking || !status.enabled || !status.provider) return;
  checking = true;
  try {
    const devices = await syncDevices();
    const key = seenDevicesKey(status.account);
    const { added, seen } = diffNewDevices(loadSeenDevices(key), devices);
    saveSeenDevices(key, seen);
    for (const d of added) toast.info(newDeviceMessage(d.name), { source: SOURCE });
  } catch {
    /* offline etc.: try again after the next sync */
  } finally {
    checking = false;
  }
}
