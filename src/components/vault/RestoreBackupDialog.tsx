import { useEffect, useReducer, useRef, useState } from "react";
import { ArchiveRestore, CircleCheck, FileArchive, FileUp, GitMerge, Lock, Replace, TriangleAlert } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Loading";
import { Stepper, useStepFocus } from "../ui/Stepper";
import { RadioCards } from "../ui/RadioCards";
import { DropZone, useDropTarget } from "../ui/DropZone";
import { useFieldError } from "./ListEditor";
import { toast } from "../../lib/toast";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { VAULT_CHANGED_EVENT, vaultErrorMessage } from "../../lib/vault";
import { activeSteps } from "../../lib/stepper";
import { getFileName, middleEllipsis } from "../../lib/pathUtils";
import {
  checkDroppedBackup, pickBackupFile, vaultBackupInspect, vaultBackupImport, vaultBackupMerge, formatBytes, mergeSummary,
  restoreCanAdvance, restoreFlow, restoreStep, restoreWizardReducer, initialRestoreWizard,
  BACKUP_EXT, REPLACE_CONFIRM_WORD, RESTORE_STEP_LABELS, type RestoreMode,
} from "../../lib/vaultBackup";

const PASSWORD_ID = "restore-backup-password";
const WRONG_PASSWORD = "That isn't the master password this backup was made with";

const METHODS = [
  {
    value: "merge" as const, title: "Merge into this vault", badge: "Recommended", icon: <GitMerge size={16} />,
    description: "Adds the backup's items; nothing here is removed; your master password stays.",
  },
  {
    value: "replace" as const, title: "Replace this vault", danger: true, icon: <Replace size={16} />,
    description: "Replaces this vault with the backup, including its master password. A copy is kept.",
  },
];

/**
 * Restore a `.nqb` file as a stepper: File (drop or choose, then checked) → Method (merge or replace,
 * only when a vault exists here) → Confirm (the backup's password, or typing REPLACE) → Done. The steps
 * are lib/vaultBackup's `restoreWizardReducer`; this component runs the commands and renders.
 * Mounted on demand by the setup screen and by Settings -> Vault -> Backup.
 */
export function RestoreBackupDialog({ onClose, initialPath }: { onClose: () => void; /** A backup to check as soon as the dialog opens (opened from Explorer). */ initialPath?: string }) {
  const exists = useVaultStore((s) => s.exists);
  const unlocked = useVaultStore((s) => s.unlocked);
  const [w, dispatch] = useReducer(restoreWizardReducer, initialRestoreWizard);
  const [busy, setBusy] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useStepFocus(rootRef, w.step);

  // After a restore the vault exists here: the Done step keeps the steps the user went through.
  const hasVault = w.step === "done" ? w.hadVault : exists;
  const steps = activeSteps(restoreFlow(hasVault)).map((key) => ({ key, label: RESTORE_STEP_LABELS[key] }));
  const merging = exists && w.mode === "merge";
  const submitState = restoreStep({ checked: !!w.info, exists, unlocked, mode: w.mode, typed: w.typed, password: w.password, busy });
  const canNext = restoreCanAdvance(w, { exists, unlocked });
  const passwordError = useFieldError(w.step === "confirm" && merging ? w.error : null);

  // ── File ───────────────────────────────────────────────────────────────────

  const inspect = async (path: string) => {
    dispatch({ type: "choose", path });
    try {
      const info = await vaultBackupInspect(path);
      if (!info.ok) throw new Error("This file isn't a valid Notiq backup");
      dispatch({ type: "checked", path, info });
    } catch (e) {
      dispatch({ type: "checkFailed", path, error: e instanceof Error ? e.message : vaultErrorMessage(e) });
    }
  };

  const started = useRef(false);
  useEffect(() => {
    if (!initialPath || started.current) return;
    started.current = true; // StrictMode runs effects twice in development
    void inspect(initialPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the path given at open matters
  }, []);

  const choose = async () => {
    try {
      const p = await pickBackupFile();
      if (p) await inspect(p);
    } catch (e) {
      dispatch({ type: "dropRefused", error: vaultErrorMessage(e) });
    }
  };

  const onDrop = async (paths: string[]) => {
    if (busy || w.checking) return;
    const r = await checkDroppedBackup(paths);
    if ("error" in r) dispatch({ type: "dropRefused", error: r.error });
    else await inspect(r.path);
  };

  // While this dialog is open it owns OS drops: on the File step anywhere on it counts as the drop zone,
  // elsewhere they are ignored (lib/dropTargets swallows drops outside a modal target).
  useDropTarget({
    id: "restore-backup-dialog",
    modal: true,
    element: () => rootRef.current?.closest(".dlg-panel") ?? null,
    enabled: !unlocking,
    onDrop: (paths) => { if (w.step === "file") void onDrop(paths); },
  });

  // ── Restore ────────────────────────────────────────────────────────────────

  // The unlock dialog sits below this one, so step aside while it is open.
  const unlock = async () => {
    setUnlocking(true);
    try { await useVaultStore.getState().ensureUnlocked(); } finally { setUnlocking(false); }
  };

  const replace = async () => {
    if (!w.path) return;
    if (exists) {
      // Saves open vault notes and locks, so nothing stale from the old vault stays on screen.
      const locked = await useAppStore.getState().lockVault();
      if (!locked) return;
    }
    const result = await vaultBackupImport(w.path, exists);
    useVaultStore.getState().setUnlocked(false);
    await useVaultStore.getState().refresh();
    dispatch({ type: "restored", result, exists });
    toast.info("Backup restored. Unlock with the master password the backup was made with.");
  };

  const merge = async () => {
    if (!w.path) return;
    try {
      const result = await vaultBackupMerge(w.path, w.password);
      window.dispatchEvent(new Event("vault:file-saved"));
      window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
      void useAppStore.getState().refreshVaultTabs().catch(() => {});
      dispatch({ type: "merged", result });
    } catch (e) {
      const msg = vaultErrorMessage(e);
      throw new Error(msg === "Wrong password" ? WRONG_PASSWORD : msg);
    }
  };

  const submit = async () => {
    if (!submitState.canSubmit) return;
    setBusy(true);
    try {
      await (merging ? merge() : replace());
    } catch (e) {
      dispatch({ type: "failed", error: e instanceof Error ? e.message : vaultErrorMessage(e) });
      if (merging) setTimeout(() => (document.getElementById(PASSWORD_ID) as HTMLInputElement | null)?.select(), 0);
    } finally {
      setBusy(false);
    }
  };

  const next = () => dispatch({ type: "next", exists, unlocked });
  const back = () => dispatch({ type: "back", exists });
  const primary = () => {
    if (w.step === "confirm") void submit();
    else if (canNext) next();
  };

  if (unlocking) return null;

  // ── Steps ──────────────────────────────────────────────────────────────────

  const unlockHandOff = merging && !unlocked && (
    <div className="mt-3 p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-xs flex items-center gap-2.5">
      <Lock size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
      <span className="flex-1">Unlock your vault first to merge the backup into it.</span>
      <Button size="sm" variant="primary" className="shrink-0 whitespace-nowrap" onClick={() => void unlock()}>Unlock vault…</Button>
    </div>
  );

  const fileName = w.path ? getFileName(w.path) : "";

  const fileStep = (
    <>
      <DropZone id="restore-backup-file" modal enabled={!busy && !w.checking} onDrop={(p) => void onDrop(p)}
                hoverLabel={`Drop to restore from this backup`} hoverIcon={<FileUp size={14} />}>
        {w.path ? (
          <div className="flex items-start gap-3 p-4" data-file-card="">
            <span aria-hidden className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-md bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-primary)]">
              <FileArchive size={18} />
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium" title={w.path} data-file-name="">{middleEllipsis(fileName, 44)}</div>
              <div className="mt-0.5 text-xs" aria-live="polite">
                {w.checking ? (
                  <span className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]"><Spinner size={12} /> Checking…</span>
                ) : w.fileError ? (
                  <span role="alert" className="inline-flex items-start gap-1.5 text-[var(--color-danger)]">
                    <TriangleAlert size={13} className="shrink-0 mt-px" aria-hidden />{w.fileError}
                  </span>
                ) : w.info ? (
                  <span className="text-[var(--color-text-muted)]">
                    <span className="inline-flex items-center gap-1 font-medium text-[var(--color-success)]">
                      <CircleCheck size={13} aria-hidden /> Valid backup
                    </span>
                    {" · "}{formatBytes(w.info.db_bytes)} of encrypted notes
                    {w.info.created ? ` · made ${new Date(w.info.created * 1000).toLocaleDateString()}` : ""}
                  </span>
                ) : null}
              </div>
              <button type="button" data-step-focus="" disabled={w.checking || busy}
                      className="mt-2 text-xs font-medium cursor-pointer text-[var(--color-primary)] hover:underline disabled:opacity-50 disabled:cursor-default"
                      onClick={() => void choose()}>
                Choose a different file
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center text-center gap-2 px-4 py-8">
            <span aria-hidden className="inline-flex items-center justify-center w-11 h-11 rounded-full bg-[var(--color-primary)]/12 text-[var(--color-primary)]">
              <FileUp size={20} />
            </span>
            <p className="text-sm font-medium">Drop a <code>.{BACKUP_EXT}</code> file here</p>
            <p className="text-xs text-[var(--color-text-muted)]">or</p>
            <Button variant="primary" className="whitespace-nowrap" data-step-focus="" onClick={() => void choose()}>
              Choose file…
            </Button>
          </div>
        )}
      </DropZone>
      {w.dropError && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-[var(--color-danger)]">
          <TriangleAlert size={13} className="shrink-0 mt-px" aria-hidden />{w.dropError}
        </p>
      )}
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        Use a backup exported from Notiq. It is checked first; nothing changes until you confirm.
      </p>
    </>
  );

  const methodStep = (
    <>
      <p className="text-sm mb-3">A vault already exists on this device. How should the backup be restored?</p>
      <RadioCards<RestoreMode> label="How to restore" value={w.mode} options={METHODS} disabled={busy}
                               onChange={(mode) => dispatch({ type: "mode", mode })} />
      {unlockHandOff}
    </>
  );

  const fromLine = (
    <p className="text-xs text-[var(--color-text-muted)] mb-3 truncate" title={w.path ?? undefined}>
      From <span className="font-medium text-[var(--color-text)]">{middleEllipsis(fileName, 48)}</span>
    </p>
  );

  const confirmStep = (
    <>
      {fromLine}
      {merging ? (
        <>
          <label className="block mb-1.5 text-sm font-medium" htmlFor={PASSWORD_ID}>
            The backup's master password
          </label>
          <PasswordInput id={PASSWORD_ID} autoComplete="off" value={w.password} disabled={busy || !unlocked}
                         data-step-focus="" className={passwordError.errorClass} {...passwordError.inputProps}
                         onChange={(e) => dispatch({ type: "password", value: e.target.value })} />
          <div role="alert">{passwordError.message}</div>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            The one the backup was made with. If a note is in both, the newer version stays and the other is kept in
            its history. A copy of your vault is kept in a <code>before-merge-…</code> folder first.
          </p>
          {unlockHandOff}
        </>
      ) : exists ? (
        <div className="p-3 rounded-lg border border-[var(--color-danger)] text-xs">
          <div className="flex items-center gap-1.5 text-sm font-semibold mb-1 text-[var(--color-danger)]">
            <TriangleAlert size={14} aria-hidden /> This replaces the vault on this device
          </div>
          <p className="mb-3 text-[var(--color-text-muted)]">
            Your current vault is copied to a <code>before-restore-…</code> folder in the app data folder first, but
            from now on only the backup's master password and recovery key will open your notes.
          </p>
          <label className="block mb-1 font-medium" htmlFor="restore-confirm">
            Type {REPLACE_CONFIRM_WORD} to continue
          </label>
          <Input id="restore-confirm" autoComplete="off" value={w.typed} data-step-focus="" disabled={busy}
                 onChange={(e) => dispatch({ type: "typed", value: e.target.value })} />
        </div>
      ) : (
        <p className="text-sm" data-step-focus="" tabIndex={-1}>
          This sets up the vault on this device from the backup. Afterwards, unlock it with the master password the
          backup was made with.
        </p>
      )}
      {w.error && !merging && <p role="alert" className="mt-2 text-xs text-[var(--color-danger)]">{w.error}</p>}
    </>
  );

  const doneStep = w.merged ? (
    <>
      <p className="text-sm font-medium">The backup was merged into your vault.</p>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">{mergeSummary(w.merged)}</p>
      <dl className="grid grid-cols-4 gap-2 my-3 text-center" data-merge-counts="">
        {([["Added", w.merged.added], ["Updated", w.merged.updated], ["Unchanged", w.merged.unchanged], ["Kept in history", w.merged.kept_in_history]] as const)
          .map(([label, n]) => (
            <div key={label} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-2">
              <dd className="text-lg font-semibold">{n}</dd>
              <dt className="text-[11px] text-[var(--color-text-muted)]">{label}</dt>
            </div>
          ))}
      </dl>
      {w.merged.previous_saved_to && (
        <p className="text-xs text-[var(--color-text-muted)]">
          Your vault from before the merge was copied to <code className="break-all">{w.merged.previous_saved_to}</code>.
        </p>
      )}
    </>
  ) : (
    <>
      <p className="text-sm font-medium">Your vault was restored.</p>
      <p className="mt-1 text-xs text-[var(--color-text-muted)]">
        It is locked: unlock it with the <b>master password you used when the backup was made</b> (or its recovery
        key via "Forgot password?").
      </p>
      {w.restored?.previous_saved_to && (
        <p className="mt-2 text-xs text-[var(--color-text-muted)]">
          Your previous vault was copied to <code className="break-all">{w.restored.previous_saved_to}</code>.
        </p>
      )}
    </>
  );

  const body = { file: fileStep, method: methodStep, confirm: confirmStep, done: doneStep }[w.step];
  const backButton = w.step !== "file" && w.step !== "done" && (
    <DialogButton variant="ghost" onClick={back} disabled={busy}>Back</DialogButton>
  );

  return (
    <Dialog onClose={onClose} dismissable={!busy} zClassName="z-[80]" size="md" title="Restore from backup file"
            icon={<ArchiveRestore size={16} />} onPrimary={primary}>
      <div ref={rootRef} className="contents" data-restore-step={w.step}>
        <DialogBody>
          <Stepper steps={steps} current={w.step} label="Restore steps" />
          {body}
        </DialogBody>
        <DialogFooter start={backButton || undefined}>
          {w.step === "done" ? (
            <>
              {w.merged ? (
                <DialogButton variant="primary" data-step-focus="" onClick={onClose}>Close</DialogButton>
              ) : (
                <>
                  <DialogButton cancel data-step-focus="" onClick={onClose}>Close</DialogButton>
                  <DialogButton variant="primary" onClick={() => { onClose(); void useVaultStore.getState().ensureUnlocked(); }}>
                    Unlock now
                  </DialogButton>
                </>
              )}
            </>
          ) : (
            <>
              <DialogButton cancel onClick={onClose} disabled={busy}>Cancel</DialogButton>
              {w.step === "confirm" ? (
                <DialogButton variant={exists && w.mode === "replace" ? "danger" : "primary"} disabled={!submitState.canSubmit}
                              loading={busy} loadingText={merging ? "Merging…" : "Restoring…"} onClick={() => void submit()}>
                  {submitState.label}
                </DialogButton>
              ) : (
                <DialogButton variant="primary" disabled={!canNext} onClick={next}>Next</DialogButton>
              )}
            </>
          )}
        </DialogFooter>
      </div>
    </Dialog>
  );
}
