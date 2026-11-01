import { useState } from "react";
import { ArchiveRestore, FileUp, Lock, TriangleAlert } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { VAULT_CHANGED_EVENT, vaultErrorMessage } from "../../lib/vault";
import {
  pickBackupFile, vaultBackupInspect, vaultBackupImport, vaultBackupMerge, formatBytes, mergeSummary, restoreStep,
  REPLACE_CONFIRM_WORD, type BackupInspect, type BackupMergeResult, type RestoreMode,
} from "../../lib/vaultBackup";

/**
 * Restore a `.nqbackup` file: pick -> inspect -> import. When a vault already exists here the backup
 * is either merged into it (needs it unlocked and the backup's master password) or replaces it
 * (typed confirmation). Mounted on demand by the setup screen and by Settings -> Vault -> Backup.
 */
export function RestoreBackupDialog({ onClose }: { onClose: () => void }) {
  const exists = useVaultStore((s) => s.exists);
  const unlocked = useVaultStore((s) => s.unlocked);
  const [path, setPath] = useState<string | null>(null);
  const [info, setInfo] = useState<BackupInspect | null>(null);
  const [mode, setMode] = useState<RestoreMode>("merge");
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [merged, setMerged] = useState<BackupMergeResult | null>(null);

  const step = restoreStep({ checked: !!info, exists, unlocked, mode, typed, password, busy });

  const choose = async () => {
    setError(null);
    try {
      const p = await pickBackupFile();
      if (!p) return;
      setPath(p); setInfo(null);
      setChecking(true);
      setInfo(await vaultBackupInspect(p));
    } catch (e) {
      setInfo(null);
      setError(vaultErrorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  // The unlock dialog sits below this one, so step aside while it is open.
  const unlock = async () => {
    setUnlocking(true);
    try { await useVaultStore.getState().ensureUnlocked(); } finally { setUnlocking(false); }
  };

  const replace = async () => {
    if (!path) return;
    if (exists) {
      // Saves open vault notes and locks, so nothing stale from the old vault stays on screen.
      const locked = await useAppStore.getState().lockVault();
      if (!locked) return;
    }
    await vaultBackupImport(path, exists);
    useVaultStore.getState().setUnlocked(false);
    await useVaultStore.getState().refresh();
    setDone(true);
    toast.info("Backup restored. Unlock with the master password the backup was made with.");
  };

  const merge = async () => {
    if (!path) return;
    try {
      const r = await vaultBackupMerge(path, password);
      setPassword("");
      window.dispatchEvent(new Event("vault:file-saved"));
      window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
      void useAppStore.getState().refreshVaultTabs().catch(() => {});
      setMerged(r);
    } catch (e) {
      const msg = vaultErrorMessage(e);
      throw new Error(msg === "Wrong password" ? "That isn't the master password this backup was made with" : msg);
    }
  };

  const submit = async () => {
    if (!step.canSubmit) return;
    setBusy(true); setError(null);
    try {
      await (exists && mode === "merge" ? merge() : replace());
    } catch (e) {
      setError(vaultErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (unlocking) return null;

  const choice = (value: RestoreMode, label: string, detail: string) => (
    <label className="flex items-start gap-2 cursor-pointer">
      <input type="radio" name="restore-mode" className="mt-0.5" checked={mode === value}
             onChange={() => { setMode(value); setError(null); }} disabled={busy} />
      <span><span className="font-medium">{label}</span> <span className="text-[var(--color-text-muted)]">{detail}</span></span>
    </label>
  );

  return (
    <Dialog onClose={onClose} dismissable={!busy} zClassName="z-[80]" size="md" title="Restore from backup file" icon={<ArchiveRestore size={16} />}>
        {merged ? (
          <>
            <DialogBody message="The backup was merged into your vault." detail={mergeSummary(merged)}>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm mb-2">
                <span>Added <strong>{merged.added}</strong></span>
                <span>Updated <strong>{merged.updated}</strong></span>
                <span>Unchanged <strong>{merged.unchanged}</strong></span>
                <span>Kept in history <strong>{merged.kept_in_history}</strong></span>
              </div>
              {merged.previous_saved_to && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Your vault from before the merge was copied to <code className="break-all">{merged.previous_saved_to}</code>.
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <DialogButton variant="primary" onClick={onClose}>Done</DialogButton>
            </DialogFooter>
          </>
        ) : done ? (
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
              <Button icon={<FileUp size={13} />} onClick={() => void choose()} disabled={busy} loading={checking} loadingText="Checking file…">
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
              <fieldset className="flex flex-col gap-1.5 mb-3 text-xs">
                <legend className="font-medium mb-1">A vault already exists on this device</legend>
                {choice("merge", "Merge into this vault", "adds the backup's notes; nothing here is removed and your master password stays the same.")}
                {choice("replace", "Replace this vault", "with the backup, including its master password.")}
              </fieldset>
            )}

            {info && exists && mode === "merge" && (step.needsUnlock ? (
              <div className="mb-3 p-2.5 rounded-md border border-[var(--color-border)] text-xs flex items-center gap-2">
                <Lock size={13} className="shrink-0" aria-hidden />
                <span className="flex-1">Unlock your vault first to merge the backup into it.</span>
                <Button size="sm" onClick={() => void unlock()}>Unlock vault…</Button>
              </div>
            ) : (
              <div className="mb-3 text-xs">
                <label className="block mb-1 text-[var(--color-text-muted)]" htmlFor="restore-backup-password">
                  The backup's master password (the one it was made with)
                </label>
                <PasswordInput id="restore-backup-password" autoComplete="off" value={password} disabled={busy}
                               onChange={(e) => setPassword(e.target.value)}
                               onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
                <p className="mt-1.5 text-[var(--color-text-muted)]">
                  If a note is in both, the newer version stays and the other is kept in its history. A copy of your
                  vault is kept in a <code>before-merge-…</code> folder first.
                </p>
              </div>
            ))}

            {info && exists && mode === "replace" && (
              <div className="mb-3 p-2.5 rounded-md border border-[var(--color-danger)] text-xs">
                <div className="flex items-center gap-1.5 font-semibold mb-1 text-[var(--color-danger)]">
                  <TriangleAlert size={13} /> This replaces the vault on this device
                </div>
                <p className="mb-2 text-[var(--color-text-muted)]">
                  Your current vault is copied to a <code>before-restore-…</code> folder in the app data folder first, but
                  from now on only the backup's master password and recovery key will open your notes.
                </p>
                <label className="block mb-1 text-[var(--color-text-muted)]" htmlFor="restore-confirm">
                  Type {REPLACE_CONFIRM_WORD} to continue
                </label>
                <Input id="restore-confirm" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </div>
            )}

            {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
            <DialogButton variant={exists && mode === "replace" ? "danger" : "primary"} disabled={!step.canSubmit} loading={busy}
                          loadingText={exists && mode === "merge" ? "Merging…" : "Restoring…"} onClick={() => void submit()}>
              {step.label}
            </DialogButton>
          </DialogFooter>
          </>
        )}
    </Dialog>
  );
}
