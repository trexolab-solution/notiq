import { useEffect, useState } from "react";
import { Download, X } from "lucide-react";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { exportBackupWithDialog } from "../../lib/vaultBackup";
import {
  BACKUP_EVENT, backupReminderReason, noteVaultSeen, readReminderInput,
  setBackupReminderDisabled, snoozeBackupReminder, describeAge, type ReminderReason,
} from "../../lib/backupReminder";

/**
 * Small dismissible banner: "Back up your vault". Renders nothing unless a reminder is due.
 * Mount it in the vault sidebar (only while the vault is unlocked, so export can run).
 */
export function BackupReminder() {
  const exists = useVaultStore((s) => s.exists);
  const unlocked = useVaultStore((s) => s.unlocked);
  const [reason, setReason] = useState<ReminderReason | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const check = () => {
      if (!exists) { setReason(null); return; }
      noteVaultSeen();
      setReason(backupReminderReason(readReminderInput()));
    };
    check();
    window.addEventListener(BACKUP_EVENT, check);
    return () => window.removeEventListener(BACKUP_EVENT, check);
  }, [exists]);

  if (!reason || !exists) return null;

  const last = readReminderInput().lastBackup;
  const text = reason === "never"
    ? "You haven't backed up your vault. It only exists on this computer."
    : `Your last vault backup was ${last ? describeAge(last, Date.now()) : "a while ago"}.`;

  const backUp = async () => {
    if (busy) return;
    if (!unlocked && !(await useVaultStore.getState().ensureUnlocked())) return;
    setBusy(true);
    try {
      if (await exportBackupWithDialog()) toast.info("Backup saved. Keep it somewhere safe.");
    } catch (e) {
      toast.error("Backup failed", { source: "Backup", detail: vaultErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      data-testid="backup-reminder"
      className="mx-2 my-1.5 p-2 rounded-md text-xs border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text)]"
    >
      <div className="flex items-start gap-2">
        <span className="flex-1">{text}</span>
        <button
          type="button" aria-label="Remind me in 7 days" title="Remind me in 7 days"
          className="shrink-0 cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          onClick={() => snoozeBackupReminder()}
        >
          <X size={12} />
        </button>
      </div>
      <div className="flex items-center justify-between mt-1.5">
        <button
          type="button" disabled={busy}
          className="inline-flex items-center gap-1 font-semibold cursor-pointer text-[var(--color-primary)] hover:underline disabled:opacity-50"
          onClick={() => void backUp()}
        >
          <Download size={11} /> {busy ? "Backing up…" : "Back up now"}
        </button>
        <button
          type="button"
          className="cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline"
          onClick={() => setBackupReminderDisabled(true)}
        >
          Don't remind me
        </button>
      </div>
    </div>
  );
}
