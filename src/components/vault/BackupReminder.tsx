import { useEffect, useState } from "react";
import { Cloud, Download, ShieldAlert, X } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { Button } from "../ui/Button";
import { BusyIcon } from "../ui/Loading";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { exportBackupWithDialog } from "../../lib/vaultBackup";
import { useSyncStatus } from "../../lib/vaultSync";
import { requestSyncSetup, syncCommandAvailability } from "../../lib/syncSurfaces";
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
  const sync = useSyncStatus();

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
  // Syncing to Drive already keeps a copy elsewhere, so "only exists on this computer" would be wrong.
  if (reason === "never" && sync?.provider && sync.enabled && sync.lastSyncedMs != null) return null;
  const canConnect = syncCommandAvailability(sync, { exists, unlocked }).connect;

  const last = readReminderInput().lastBackup;
  const title = reason === "never" ? "Vault not backed up" : "Backup is out of date";
  const text = reason === "never"
    ? "It's only on this computer."
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

  // The card follows the sidebar's width (a container query): narrow, the actions are full width, one under the
  // other; with room, they sit in a row under the text at their own size.
  const wide = "w-full justify-center !py-1.5 font-medium @md:w-auto @md:!px-3";
  const outlined = "border border-[var(--color-border)] !text-[var(--color-text)] hover:border-[var(--color-primary)]";

  return (
    <div
      role="status"
      data-testid="backup-reminder"
      className="@container mx-2 my-2 flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[var(--color-text)] shadow-sm"
    >
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--color-warning)_16%,transparent)] text-[var(--color-warning)]">
          <ShieldAlert size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold leading-snug">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-text-muted)]">{text}</p>
        </div>
        <Tooltip content="Remind me in 7 days">
          <button
            type="button" aria-label="Remind me in 7 days"
            className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded cursor-pointer text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
            onClick={() => snoozeBackupReminder()}
          >
            <X size={13} />
          </button>
        </Tooltip>
      </div>
      {/* In a row, they start where the text does (the icon's width plus the gap). */}
      <div className="flex flex-col gap-1.5 @md:flex-row @md:flex-wrap @md:items-center @md:gap-2 @md:pl-[2.625rem]">
        {canConnect && (
          <Button size="sm" variant="primary" className={wide} icon={<Cloud size={13} aria-hidden />} onClick={() => requestSyncSetup()}>
            Connect Google Drive
          </Button>
        )}
        {/* The only action, so the main one, where Drive isn't on offer. */}
        <Button
          size="sm" variant={canConnect ? "ghost" : "primary"} className={canConnect ? `${wide} ${outlined}` : wide}
          disabled={busy} aria-busy={busy || undefined} onClick={() => void backUp()}
          icon={<BusyIcon icon={Download} busy={busy} size={13} />}
        >
          {busy ? "Backing up…" : "Back up now"}
        </Button>
        <button
          type="button"
          className="mt-0.5 self-center @md:mt-0 @md:ml-auto cursor-pointer rounded px-1.5 text-[11px] text-[var(--color-text-muted)] underline-offset-2 hover:text-[var(--color-text)] hover:underline"
          onClick={() => setBackupReminderDisabled(true)}
        >
          Don't remind me
        </button>
      </div>
    </div>
  );
}
