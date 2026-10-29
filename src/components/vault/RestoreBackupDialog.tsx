import { useState } from "react";
import { ArchiveRestore, FileUp, TriangleAlert } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import {
  pickBackupFile, vaultBackupInspect, vaultBackupImport, formatBytes, type BackupInspect,
} from "../../lib/vaultBackup";

const CONFIRM_WORD = "REPLACE";

/**
 * Restore a `.nqbackup` file: pick -> inspect -> (confirm when a vault already exists) -> import.
 * Mounted on demand by the setup screen and by Settings -> Vault -> Backup.
 */
export function RestoreBackupDialog({ onClose }: { onClose: () => void }) {
  const exists = useVaultStore((s) => s.exists);
  const [path, setPath] = useState<string | null>(null);
  const [info, setInfo] = useState<BackupInspect | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const choose = async () => {
    setError(null);
    try {
      const p = await pickBackupFile();
      if (!p) return;
      setPath(p); setInfo(null);
      setInfo(await vaultBackupInspect(p));
    } catch (e) {
      setInfo(null);
      setError(vaultErrorMessage(e));
    }
  };

  const restore = async () => {
    if (!path || !info || busy) return;
    setBusy(true); setError(null);
    try {
      if (exists) {
        // Saves open vault notes and locks, so nothing stale from the old vault stays on screen.
        const locked = await useAppStore.getState().lockVault();
        if (!locked) { setBusy(false); return; }
      }
      await vaultBackupImport(path, exists);
      useVaultStore.getState().setUnlocked(false);
      await useVaultStore.getState().refresh();
      setDone(true);
      toast.info("Backup restored. Unlock with the master password the backup was made with.");
    } catch (e) {
      setError(vaultErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canRestore = !!info && !busy && (!exists || typed === CONFIRM_WORD);
  return (
    <Dialog onClose={onClose} zClassName="z-[80]" size="md" title="Restore from backup file" icon={<ArchiveRestore size={16} />}>
        {done ? (
          <>
            <DialogBody
              message="Your vault was restored."
              detail={<>It is locked: unlock it with the <b>master password you used when the backup
                was made</b> (or its recovery key via "Forgot password?").</>}
            />
            <DialogFooter>
              <DialogButton cancel onClick={onClose}>Close</DialogButton>
              <DialogButton variant="primary" onClick={() => { onClose(); void useVaultStore.getState().ensureUnlocked(); }}>
                Unlock now
              </DialogButton>
            </DialogFooter>
          </>
        ) : (
          <>
          <DialogBody
            message={<>Choose a <code>.nqbackup</code> file exported from Notiq.</>}
            detail="The file is checked first; nothing is changed until you confirm."
          >
            <div className="flex items-center gap-2 mb-3">
              <Button icon={<FileUp size={13} />} onClick={() => void choose()} disabled={busy}>
                {path ? "Choose another file…" : "Choose backup file…"}
              </Button>
              {path && <span className="text-xs truncate text-[var(--color-text-muted)]" title={path}>{path}</span>}
            </div>

            {info && (
              <div className="text-xs mb-3 p-2.5 rounded-md bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
                Valid backup · {formatBytes(info.db_bytes)} of encrypted notes
                {info.created ? ` · file dated ${new Date(info.created * 1000).toLocaleDateString()}` : ""}
              </div>
            )}

            {info && exists && (
              <div className="mb-3 p-2.5 rounded-md border border-[var(--color-danger)] text-xs">
                <div className="flex items-center gap-1.5 font-semibold mb-1 text-[var(--color-danger)]">
                  <TriangleAlert size={13} /> This replaces the vault on this device
                </div>
                <p className="mb-2 text-[var(--color-text-muted)]">
                  Your current vault is copied to a <code>before-restore-…</code> folder in the app data folder first, but
                  from now on only the backup's master password and recovery key will open your notes.
                </p>
                <label className="block mb-1 text-[var(--color-text-muted)]" htmlFor="restore-confirm">
                  Type {CONFIRM_WORD} to continue
                </label>
                <Input id="restore-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </div>
            )}

            {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
            <DialogButton variant={exists ? "danger" : "primary"} disabled={!canRestore} onClick={() => void restore()}>
              {busy ? "Restoring…" : exists ? "Replace vault" : "Restore vault"}
            </DialogButton>
          </DialogFooter>
          </>
        )}
    </Dialog>
  );
}
