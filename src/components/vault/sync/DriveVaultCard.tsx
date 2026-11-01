import { Spinner } from "../../ui/Loading";
import { useEffect, useState } from "react";
import { Cloud } from "lucide-react";
import { PasswordInput } from "../../ui/PasswordInput";
import { syncDevices, syncRemoteInfo, useSyncStatus, type SyncDevice } from "../../../lib/vaultSync";
import { lastChangedText } from "../../../lib/syncSetup";
import { openDriveVault } from "../../../lib/syncSetupFlow";

/** "you@gmail.com · last changed on LAPTOP, 2 hours ago" (parts that are unknown are left out). */
export const driveVaultLine = (account: string | null, devices: SyncDevice[] | null, now = Date.now()) =>
  [account, lastChangedText(devices, now)].filter(Boolean).join(" · ");

/**
 * The body of "Your vault is in Google Drive": account line + master password field + inline error.
 * Shared by the vault sidebar card and the setup flow dialog (they place their own Open vault button).
 */
export function DriveVaultFields({ idPrefix, account, devices, password, onPassword, busy, error, replaceLocal, autoFocus }: {
  idPrefix: string;
  account: string | null;
  devices: SyncDevice[] | null;
  password: string;
  onPassword: (v: string) => void;
  busy: boolean;
  error: string | null;
  /** An empty local vault is replaced (a backup is kept). */
  replaceLocal?: boolean;
  autoFocus?: boolean;
}) {
  const line = driveVaultLine(account, devices);
  const errId = `${idPrefix}-error`;
  return (
    <div className="flex flex-col gap-2 text-left">
      {line && <p className="text-[11.5px] text-[var(--color-text-muted)] break-words" data-testid="drive-vault-line">{line}</p>}
      {replaceLocal && (
        <p className="text-[11.5px] text-[var(--color-text-muted)]">
          The empty vault on this PC is replaced. A backup of it is kept.
        </p>
      )}
      <div>
        <label className="block text-xs mb-1 text-[var(--color-text-muted)]" htmlFor={`${idPrefix}-password`}>Master password</label>
        <PasswordInput
          id={`${idPrefix}-password`} autoFocus={autoFocus} autoComplete="current-password" disabled={busy}
          value={password} onChange={(e) => onPassword(e.target.value)}
          aria-invalid={!!error} aria-describedby={error ? errId : undefined}
        />
      </div>
      {error && <p id={errId} role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );
}

export type DriveVaultHint = { exists: boolean; devices: SyncDevice[] | null } | null;

/**
 * No local vault but Google Drive is connected: does Drive hold a vault? (null while unknown / not connected).
 * Re-checks whenever the account changes, so the sidebar updates right after connecting.
 */
export function useDriveVaultHint(localExists: boolean): DriveVaultHint {
  const status = useSyncStatus();
  const account = status?.provider ? status.account ?? "connected" : null;
  const [hint, setHint] = useState<DriveVaultHint>(null);
  useEffect(() => {
    setHint(null);
    if (localExists || !account) return;
    let live = true;
    (async () => {
      try {
        const info = await syncRemoteInfo();
        const devices = info.exists ? await syncDevices().catch(() => null) : null;
        if (live) setHint({ exists: info.exists, devices });
      } catch { /* offline etc.: show the normal empty state */ }
    })();
    return () => { live = false; };
  }, [localExists, account]);
  return hint;
}

/** Vault sidebar, no local vault, Drive has one: open it right here (F2 inline). */
export function DriveVaultCard({ account, devices }: { account: string | null; devices: SyncDevice[] | null }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const out = await openDriveVault(password, false, devices);
    if (out.ok) { setPassword(""); return; } // the panel switches to the vault
    setBusy(false);
    setError("noRemote" in out ? "Your Google Drive has no vault anymore. Create a new vault instead." : out.error);
  };

  return (
    <form onSubmit={submit} className="w-full flex flex-col gap-2 rounded-md p-3 border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]"
          aria-labelledby="sidebar-drive-title" data-testid="drive-vault-card">
      <div className="flex items-center gap-2">
        <Cloud size={14} className="shrink-0 text-[var(--color-primary)]" aria-hidden />
        <span id="sidebar-drive-title" className="text-[12.5px] font-semibold text-[var(--color-text)] text-left">Your vault is in Google Drive</span>
      </div>
      <DriveVaultFields
        idPrefix="sidebar-drive" account={account} devices={devices} password={password}
        onPassword={(v) => { setPassword(v); setError(null); }} busy={busy} error={error}
      />
      <button
        type="submit" disabled={busy} aria-busy={busy || undefined}
        className="mt-1 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold cursor-pointer bg-[var(--color-primary)] text-[var(--color-bg)] hover:bg-[var(--color-primary-hover)] disabled:opacity-60 disabled:cursor-not-allowed aria-busy:disabled:cursor-progress focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-primary)]"
      >
        {busy && <Spinner size={12} />}
        {busy ? "Opening…" : "Open vault"}
      </button>
    </form>
  );
}
