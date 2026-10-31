import { useCallback, useEffect, useState } from "react";
import { Cloud, ExternalLink, Loader2, LogOut, RefreshCw, Trash2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { SettingRow } from "../SettingRow";
import { SettingsBlock } from "../SettingsGroup";
import { Button } from "../Button";
import { Toggle } from "../Toggle";
import { Input } from "../Input";
import { Tooltip } from "../Tooltip";
import { ConfirmDialog } from "../ConfirmDialog";
import { AdoptRemoteDialog } from "../../vault/sync/AdoptRemoteDialog";
import { useSyncConnect, WAITING_FOR_GOOGLE } from "../../vault/sync/useSyncConnect";
import { toast } from "../../../lib/toast";
import { useVaultStore } from "../../../store/vaultStore";
import {
  ATTACHMENT_LIMITS_TEXT, GOOGLE_PERMISSIONS_URL, deviceNameError, describeSyncResult, relativeTime,
  syncDevices, syncDisable, syncDisconnect, syncErrorMessage, syncNow, syncRemoveDevice, syncSetDeviceName,
  useSyncStatus, useSyncStore, type SyncDevice, type SyncStatus,
} from "../../../lib/vaultSync";
import { turnOnSyncWithFeedback } from "../../../lib/syncFeedback";
import { SYNC_INDEX } from "./syncIndex";

/** Search words for a row: its index keywords plus the index description (row descriptions are live text). */
const k = (id: string): string[] => {
  const m = SYNC_INDEX.find((x) => x.id === id);
  return m ? [...(m.keywords ?? []), m.description ?? ""] : [];
};

export const DISCONNECT_MESSAGE =
  "This PC stops syncing and forgets your Google sign-in. Your vault on this PC is not changed.";
export const DISCONNECT_DETAIL =
  "Your synced vault stays in your Google Drive, so your other devices keep syncing. To delete it from Drive, open Google Drive → Settings → Manage apps, find Notiq, then choose Options → \"Delete hidden app data\".";

/** Re-renders every 30 s so "5 minutes ago" stays true. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/** Text of the "Sync status" row. */
export function statusLine(s: SyncStatus, now: number): string {
  if (!s.enabled) return "Sync is off on this PC.";
  switch (s.state) {
    case "syncing": return "Syncing…";
    case "locked": return "Paused while the vault is locked. It syncs again when you unlock.";
    case "offline": return `Offline. Changes will sync when you're back online. Last synced ${relativeTime(s.lastSyncedMs, now)}.`;
    case "authNeeded": return "Google needs you to sign in again. Choose Reconnect.";
    case "error": return `Problem: ${s.lastError ?? "the last sync failed"}. Last synced ${relativeTime(s.lastSyncedMs, now)}.`;
    default:
      return `Last synced ${relativeTime(s.lastSyncedMs, now)}${s.lastSyncedMs ? ` (${new Date(s.lastSyncedMs).toLocaleString()})` : ""}.${s.pending ? " Some changes are waiting to upload." : ""}`;
  }
}

/** Shown until the sync status is known: "Checking sync…", or why it failed with a Retry button. */
export function SyncStatusFallback({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <SettingRow id="vault.sync.account" label="Google Drive account" keywords={k("vault.sync.account")}
                description={error ? `Couldn't check sync: ${error}` : "Checking sync…"} danger={!!error}>
      {error ? (
        <Button className="settings-btn" size="sm" icon={<RefreshCw size={12} />} onClick={onRetry}>Retry</Button>
      ) : (
        <Loader2 size={14} className="animate-spin text-[var(--color-text-muted)]" aria-hidden />
      )}
    </SettingRow>
  );
}

/** Settings → Vault → Sync: renders the rows of that group (put it inside a SettingsGroup). */
export function SyncSection() {
  const status = useSyncStatus();
  const statusError = useSyncStore((s) => s.error);
  const exists = useVaultStore((s) => s.exists);
  const now = useNow();
  const { connecting, error: connectError, connect, cancel } = useSyncConnect((s) => {
    toast.success(`Connected to Google Drive${s.account ? ` as ${s.account}` : ""}`);
  });

  const [busy, setBusy] = useState<null | "enable" | "now" | "name">(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [adopting, setAdopting] = useState(false);

  const connected = !!status?.provider;
  const configured = !!status?.configured;
  const problem = status?.state === "authNeeded" || status?.state === "error";

  const turnOn = async () => {
    if (!(await useVaultStore.getState().ensureUnlocked())) return; // merging needs the vault key
    setBusy("enable");
    const out = await turnOnSyncWithFeedback(); // first upload progress + result toasts
    setBusy(null);
    if (out.kind === "different") setAdopting(true);
  };

  const turnOff = async () => {
    setBusy("enable");
    try {
      await syncDisable();
      toast.info("Sync is off on this PC. Your synced vault stays in your Google Drive.");
    } catch (e) {
      toast.error(syncErrorMessage(e));
    } finally {
      setBusy(null);
      void useSyncStore.getState().refresh();
    }
  };

  const runNow = async () => {
    setBusy("now");
    try {
      const r = await syncNow();
      toast.info(describeSyncResult(r) ?? "Your vault is up to date.", { source: "Vault sync" });
    } catch (e) {
      toast.error("Sync failed", { source: "Vault sync", detail: syncErrorMessage(e) });
    } finally {
      setBusy(null);
      void useSyncStore.getState().refresh();
    }
  };

  const disconnect = async () => {
    setConfirmDisconnect(false);
    try {
      await syncDisconnect();
      toast.info("Disconnected from Google Drive. Your synced vault is still in your Drive.");
    } catch (e) {
      toast.error(syncErrorMessage(e));
    } finally {
      void useSyncStore.getState().refresh();
    }
  };

  if (!status) return <SyncStatusFallback error={statusError} onRetry={() => void useSyncStore.getState().refresh()} />;

  const accountText = !configured
    ? "Sync isn't available in this build of Notiq (no Google sign-in is set up)."
    : connecting
      ? WAITING_FOR_GOOGLE
      : connected
        ? `Google Drive · ${status.account ?? "connected"}. Notiq can only see its own files in your Drive.`
        : "Sync your vault through your own Google Drive. Notiq can only see its own files there, and everything is encrypted before it leaves this PC.";

  return (
    <>
      <SettingRow id="vault.sync.account" label="Google Drive account" keywords={k("vault.sync.account")}
                  description={connectError ? `${accountText} ${connectError}` : accountText}>
        {connecting ? (
          <Button className="settings-btn" size="sm" onClick={cancel}>Cancel</Button>
        ) : connected ? (
          <>
            {status.state === "authNeeded" && (
              <Button className="settings-btn-primary" variant="primary" size="sm" icon={<RefreshCw size={12} />}
                      onClick={() => void connect()}>Reconnect</Button>
            )}
            <Button className="settings-btn" size="sm" icon={<LogOut size={12} />} onClick={() => setConfirmDisconnect(true)}>
              Disconnect…
            </Button>
          </>
        ) : (
          <Button className="settings-btn-primary" variant="primary" size="sm" icon={<Cloud size={12} />}
                  disabled={!configured} onClick={() => void connect()}>Connect Google Drive</Button>
        )}
      </SettingRow>

      <SettingRow id="vault.sync.enabled" label="Sync this vault" keywords={k("vault.sync.enabled")}
                  description={!exists ? "Set up the vault first." : !connected ? "Connect Google Drive first."
                    : "Keep this vault the same on all your PCs. Changes upload a few seconds after you make them, while the vault is unlocked."}
                  disabled={!connected || !exists}>
        <Toggle aria-label="Sync this vault" value={status.enabled} disabled={!connected || !exists || busy === "enable"}
                onChange={(v) => void (v ? turnOn() : turnOff())} />
      </SettingRow>

      {connected && (
        <SettingRow id="vault.sync.status" label="Sync status" keywords={k("vault.sync.status")}
                    description={statusLine(status, now)} danger={problem}>
          {status.state === "authNeeded" ? (
            <Button className="settings-btn-primary" variant="primary" size="sm" onClick={() => void connect()}>Reconnect</Button>
          ) : (
            <Button className="settings-btn" size="sm" icon={<RefreshCw size={12} className={busy === "now" || status.state === "syncing" ? "animate-spin" : undefined} />}
                    disabled={!status.enabled || status.state === "locked" || busy === "now"} onClick={() => void runNow()}>
              Sync now
            </Button>
          )}
        </SettingRow>
      )}

      {connected && <DeviceNameRow status={status} />}
      {connected && <DevicesBlock status={status} />}

      <SettingRow id="vault.sync.limits" label="Attachment limits" keywords={k("vault.sync.limits")}
                  description={`Attachments sync too. ${ATTACHMENT_LIMITS_TEXT}`}>
        {null}
      </SettingRow>

      <SettingRow id="vault.sync.permissions" label="Google account permissions" keywords={k("vault.sync.permissions")}
                  description="See or remove Notiq's access to your Google account on Google's permissions page.">
        <Button className="settings-btn" size="sm" icon={<ExternalLink size={12} />}
                onClick={() => { openUrl(GOOGLE_PERMISSIONS_URL).catch((e) => toast.error(String(e))); }}>
          Open
        </Button>
      </SettingRow>

      {confirmDisconnect && (
        <ConfirmDialog
          title="Disconnect Google Drive?"
          message={DISCONNECT_MESSAGE}
          detail={DISCONNECT_DETAIL}
          confirmLabel="Disconnect"
          danger
          onConfirm={() => void disconnect()}
          onCancel={() => setConfirmDisconnect(false)}
        />
      )}
      {adopting && (
        <AdoptRemoteDialog onClose={(done) => {
          setAdopting(false);
          if (done) toast.success("Sync is on. This PC now uses the vault from your Google Drive.");
          void useSyncStore.getState().refresh();
        }} />
      )}
    </>
  );
}

function DeviceNameRow({ status }: { status: SyncStatus }) {
  const [name, setName] = useState(status.deviceName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(status.deviceName); }, [status.deviceName]);

  const changed = name.trim() !== status.deviceName;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const problem = deviceNameError(name);
    if (problem) { setError(problem); return; }
    if (!changed || busy) return;
    setBusy(true);
    try {
      useSyncStore.getState().setStatus(await syncSetDeviceName(name.trim()));
      setError(null);
    } catch (err) {
      setError(syncErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow id="vault.sync.device-name" label="This device's name" keywords={k("vault.sync.device-name")}
                description={error ?? "How this PC appears in the devices list and in conflict notices."} danger={!!error}>
      <form onSubmit={save} className="flex items-center gap-2">
        <Input aria-label="This device's name" value={name} maxLength={40} className="w-[180px]"
               onChange={(e) => { setName(e.target.value); setError(null); }} />
        <Button className="settings-btn" size="sm" type="submit" disabled={!changed || busy}>Save</Button>
      </form>
    </SettingRow>
  );
}

function DevicesBlock({ status }: { status: SyncStatus }) {
  const now = useNow();
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<SyncDevice | null>(null);

  const load = useCallback(async () => {
    try { setDevices(await syncDevices()); setError(null); } catch (e) { setError(syncErrorMessage(e)); }
  }, []);
  // Reload after each sync (lastSyncedMs moves) and after renaming this device.
  useEffect(() => { void load(); }, [load, status.lastSyncedMs, status.deviceName, status.enabled]);

  const remove = async (d: SyncDevice) => {
    setRemoving(null);
    try {
      await syncRemoveDevice(d.id);
      toast.info(`Removed ${d.name}`);
    } catch (e) {
      toast.error(syncErrorMessage(e));
    } finally {
      void load();
    }
  };

  return (
    <SettingsBlock id="vault.sync.devices" label="Devices" keywords={k("vault.sync.devices")}>
      <div className="flex flex-col gap-2">
        <span className="setting-row-label">Devices</span>
        {error ? (
          <p className="text-xs text-[var(--color-text-muted)]">Couldn't load the devices: {error}</p>
        ) : !devices ? (
          <p className="text-xs text-[var(--color-text-muted)]">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)]">No devices have synced yet.</p>
        ) : (
          <ul className="flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]" aria-label="Synced devices">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 px-2.5 py-1.5">
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate" title={d.name}>
                    {d.name}{d.thisDevice && <span className="text-[var(--color-text-muted)]"> (this device)</span>}
                  </div>
                  <div className="text-[11px] text-[var(--color-text-muted)]">
                    {d.thisDevice ? "This PC" : `Last seen ${relativeTime(d.lastSeenMs, now)}`}
                  </div>
                </div>
                {!d.thisDevice && (
                  <Tooltip content="Remove this device">
                    <Button size="sm" variant="danger" aria-label={`Remove ${d.name}`} icon={<Trash2 size={13} />}
                            onClick={() => setRemoving(d)} />
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message="Its synced copy is deleted from your Google Drive. Use this for a PC you no longer use; if that PC syncs again, it shows up here again."
          confirmLabel="Remove"
          danger
          onConfirm={() => void remove(removing)}
          onCancel={() => setRemoving(null)}
        />
      )}
    </SettingsBlock>
  );
}
