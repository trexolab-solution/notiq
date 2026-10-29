import { useEffect, useState } from "react";
import { Download, FileUp, ShieldCheck } from "lucide-react";
import { Modal } from "../ui/Modal";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { SettingRow } from "../ui/SettingRow";
import { RestoreBackupDialog } from "./RestoreBackupDialog";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { exportBackupWithDialog, vaultVerifyPassword, formatBytes } from "../../lib/vaultBackup";
import {
  BACKUP_EVENT, describeAge, getLastBackup, noteVaultSeen,
  getBackupReminderDisabled, setBackupReminderDisabled,
} from "../../lib/backupReminder";
import { Toggle } from "../ui/Toggle";

/** Settings -> Vault -> "Backup". Self-contained: mount `<BackupSection />` anywhere in the Vault settings. */
export function BackupSection() {
  const exists = useVaultStore((s) => s.exists);
  const [last, setLast] = useState<number | null>(() => getLastBackup());
  const [remind, setRemind] = useState(() => !getBackupReminderDisabled());
  const [askPw, setAskPw] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const sync = () => { setLast(getLastBackup()); setRemind(!getBackupReminderDisabled()); };
    window.addEventListener(BACKUP_EVENT, sync);
    return () => window.removeEventListener(BACKUP_EVENT, sync);
  }, []);
  useEffect(() => { if (exists) noteVaultSeen(); }, [exists]);

  const runExport = async () => {
    setBusy(true);
    try {
      const res = await exportBackupWithDialog();
      if (res) toast.info(`Backup saved (${formatBytes(res.bytes)}). Keep it somewhere safe.`);
    } catch (e) {
      toast.error(`Backup failed: ${vaultErrorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (busy) return;
    const { unlocked } = useVaultStore.getState();
    if (!unlocked) {
      // Unlocking with the master password is itself the password check.
      if (!(await useVaultStore.getState().ensureUnlocked())) return;
      await runExport();
    } else {
      setAskPw(true);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="vault-backup">
      <h3 className="text-sm font-semibold text-[var(--color-text)]">Backup</h3>
      <p className="text-xs text-[var(--color-text-muted)]">
        Your vault lives only on this computer. Export an encrypted backup to keep a copy elsewhere. The backup
        is still protected by your master password and recovery key; keep it somewhere safe. Without the backup file
        plus the master password or recovery key, it cannot be opened.
      </p>

      <SettingRow
        label="Last backup"
        description={last ? `${describeAge(last, Date.now())} (${new Date(last).toLocaleString()})` : "You haven't exported a backup yet."}
      >
        <Button size="sm" variant="primary" icon={<Download size={12} />} disabled={!exists || busy} onClick={() => void start()}>
          Export encrypted backup…
        </Button>
      </SettingRow>

      <SettingRow label="Import backup" description="Restore a .nqbackup file. If a vault already exists here it will be replaced (a copy is kept).">
        <Button size="sm" icon={<FileUp size={12} />} onClick={() => setRestoring(true)}>Import backup…</Button>
      </SettingRow>

      <SettingRow label="Remind me to back up" description="A reminder appears if you never backed up (after 3 days) or the last backup is over 30 days old.">
        <Toggle value={remind} onChange={(v) => { setRemind(v); setBackupReminderDisabled(!v); }} aria-label="Remind me to back up" />
      </SettingRow>

      {askPw && (
        <PasswordPrompt
          onCancel={() => setAskPw(false)}
          onVerified={() => { setAskPw(false); void runExport(); }}
        />
      )}
      {restoring && <RestoreBackupDialog onClose={() => setRestoring(false)} />}
    </div>
  );
}

function PasswordPrompt({ onCancel, onVerified }: { onCancel: () => void; onVerified: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !pw) { if (!pw) setError("Enter your master password"); return; }
    setBusy(true); setError(null);
    try {
      await vaultVerifyPassword(pw);
      setPw("");
      onVerified();
    } catch (err) {
      setError(vaultErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onCancel} zClassName="z-[80]">
      <form
        onSubmit={submit}
        role="dialog" aria-modal="true" aria-label="Confirm master password"
        className="w-[380px] max-w-[92vw] rounded-xl p-5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]"
      >
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck size={18} style={{ color: "var(--color-primary)" }} />
          <h2 className="text-sm font-semibold">Confirm your master password</h2>
        </div>
        <p className="text-xs mb-3 text-[var(--color-text-muted)]">
          Needed to export a backup of your vault. The backup stays encrypted.
        </p>
        <PasswordInput autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        {error && <p role="alert" className="text-xs mt-2 text-[var(--color-danger)]">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <Button type="button" onClick={onCancel}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Checking…" : "Continue"}</Button>
        </div>
      </form>
    </Modal>
  );
}
