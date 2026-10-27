import { useState } from "react";
import { CloudUpload } from "lucide-react";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../../store/vaultStore";
import { neverRemindBackup, openSettingsAt, snoozeBackupReminder } from "../../lib/backupPrompt";
import { errText, gdriveConnect, runSync } from "../../lib/telegram";

/**
 * Offered right after the vault is created, and as a reminder (every few days)
 * while no sync provider is connected. Losing this computer would otherwise
 * mean losing every locked note.
 */
export function BackupPromptDialog() {
  const open = useVaultStore((s) => s.backupPrompt);
  const close = useVaultStore((s) => s.setBackupPrompt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!open) return null;

  const later = () => { snoozeBackupReminder(); close(false); };
  const never = () => { neverRemindBackup(); close(false); };

  const drive = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      toast.info("Finish signing in in your browser…");
      const email = await gdriveConnect();
      toast.info(`Backup is on (${email}). Syncing your notes…`);
      close(false);
      window.dispatchEvent(new Event("telegram:changed"));
      await runSync();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const telegram = () => { close(false); openSettingsAt("vault"); };

  return (
    <Modal onClose={later} zClassName="z-[70]">
      <div className="w-[420px] max-w-[92vw] rounded-xl p-5 bg-[var(--color-bg-secondary)] border border-[var(--color-border)] shadow-2xl text-[var(--color-text)]"
           role="dialog" aria-modal="true" aria-label="Back up your vault">
        <div className="flex items-center gap-2 mb-2">
          <CloudUpload size={18} style={{ color: "var(--color-primary)" }} />
          <h2 className="text-sm font-semibold">Back up your vault</h2>
        </div>
        <p className="text-xs mb-2 text-[var(--color-text-muted)]">
          Right now your locked notes exist only on this computer. If it is lost or reset, they are gone.
          Turn on sync and they are kept, encrypted, in your own Google Drive or Telegram, and stay in step across your devices.
        </p>
        <p className="text-xs mb-4 text-[var(--color-text-muted)]">
          Only encrypted files leave the app, under random names. Nobody, including us, can read them without your master password.
        </p>
        {error && <p role="alert" className="text-xs mb-3 text-[var(--color-danger)]">{error}</p>}
        <div className="flex flex-col gap-2">
          <Button variant="primary" disabled={busy} onClick={() => void drive()}>
            {busy ? "Waiting for sign-in…" : "Back up to Google Drive"}
          </Button>
          <Button disabled={busy} onClick={telegram}>Use Telegram instead</Button>
        </div>
        <div className="flex items-center justify-between mt-4 text-xs">
          <button type="button" className="underline cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={later}>
            Remind me later
          </button>
          <button type="button" className="underline cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={never}>
            Don't ask again
          </button>
        </div>
      </div>
    </Modal>
  );
}
