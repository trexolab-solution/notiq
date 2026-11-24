import { useEffect, useRef, useState } from "react";
import { CircleCheck, FileArchive, FileUp, Lock, PackageOpen, TriangleAlert } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { Spinner } from "../ui/Loading";
import { Stepper, useStepFocus } from "../ui/Stepper";
import { ShareItemList } from "./ShareItemList";
import { DropZone, useDropTarget } from "../ui/DropZone";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { getFileName, middleEllipsis } from "../../lib/pathUtils";
import { refreshVaultUi } from "../../lib/syncSetupFlow";
import { BACKUP_EXT, checkDroppedBackup, formatBytes, vaultBackupInspect } from "../../lib/vaultBackup";
import {
  importSummary, pickShareFile, problemText, shareNoteLines, vaultShareImport, vaultShareInspect,
  type ShareImportResult, type ShareInfo,
} from "../../lib/vaultShare";

type Step = "file" | "password" | "review" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "file", label: "File" }, { key: "password", label: "Password" }, { key: "review", label: "Review" }, { key: "done", label: "Done" },
];
const NOT_A_SHARE = "This is a normal backup, not a share file. Use \"Restore a backup\" for it.";

/**
 * Import shared items, as a stepper like the restore dialog: File (drop or choose) → Password (the one the sender gave
 * you) → Review (what is in it, and the short note: when the items go, how often the file can be imported, that the
 * file is deleted) → Done. A share only goes into a vault that exists and is open.
 */
export function ImportSharedDialog({ onClose, initialPath }: { onClose: () => void; initialPath?: string }) {
  const [step, setStep] = useState<Step>("file");
  const [path, setPath] = useState<string | null>(null);
  const [size, setSize] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [result, setResult] = useState<ShareImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useStepFocus(rootRef, step);

  // ── File ───────────────────────────────────────────────────────────────────

  /** Looks at the file's header (no password needed): it has to be a share file. */
  const inspect = async (p: string) => {
    setPath(p); setSize(null); setFileError(null); setInfo(null); setChecking(true);
    try {
      const h = await vaultBackupInspect(p);
      if (!h.ok) throw new Error("This file isn't a valid Notiq file.");
      if (h.kind !== "share") throw new Error(NOT_A_SHARE);
      setSize(h.db_bytes);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : vaultErrorMessage(e));
    } finally {
      setChecking(false);
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
      const p = await pickShareFile();
      if (p) await inspect(p);
    } catch (e) { setFileError(vaultErrorMessage(e)); }
  };

  const onDrop = async (paths: string[]) => {
    if (busy || checking) return;
    const r = await checkDroppedBackup(paths);
    if ("error" in r) { setFileError(r.error); return; }
    await inspect(r.path);
  };

  // While this dialog is open it owns OS drops: on the File step anywhere on it is the drop zone.
  useDropTarget({
    id: "import-shared-dialog", modal: true, element: () => rootRef.current?.closest(".dlg-panel") ?? null, enabled: true,
    onDrop: (paths) => { if (step === "file") void onDrop(paths); },
  });

  // ── Password and review ────────────────────────────────────────────────────

  const open = async () => {
    if (!path || !password || busy) return;
    setBusy(true); setError(null);
    try {
      setInfo(await vaultShareInspect(path, password));
      setStep("review");
    } catch (e) { setError(vaultErrorMessage(e)); }
    finally { setBusy(false); }
  };

  const unlock = async () => {
    if (!(await useVaultStore.getState().ensureUnlocked()) || !path) return;
    try { setInfo(await vaultShareInspect(path, password)); } catch (e) { setError(vaultErrorMessage(e)); }
  };

  const doImport = async () => {
    if (!path || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await vaultShareImport(path, password);
      setPassword("");
      await refreshVaultUi();
      if (res.deleteFailed) toast.warning("The share file couldn't be deleted. You can delete it yourself.", { source: "Import" });
      setResult(res);
      setStep("done");
    } catch (e) {
      setError(vaultErrorMessage(e));
    } finally { setBusy(false); }
  };

  const canImport = !!info && info.vault === "ready" && !info.problem;
  const canNext = step === "file" ? !!path && !checking && !fileError && size != null : step === "password" ? !!password && !busy : false;
  const next = () => { if (step === "file" && canNext) { setError(null); setStep("password"); } else if (step === "password") void open(); };
  const back = () => { setError(null); setStep(step === "review" ? "password" : "file"); };
  const primary = () => { if (step === "review") { if (canImport) void doImport(); } else if (step !== "done") next(); };

  const fileName = path ? getFileName(path) : "";
  const lines = info ? shareNoteLines(info, Date.now()) : [];

  const fileStep = (
    <>
      <DropZone id="import-shared-file" modal enabled={!busy && !checking} onDrop={(p) => void onDrop(p)}
                hoverLabel="Drop to import this share file" hoverIcon={<FileUp size={14} />}>
        {path ? (
          <div className="flex items-start gap-3 p-4" data-file-card="">
            <span aria-hidden className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-primary)]">
              <FileArchive size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium" data-file-name="">{middleEllipsis(fileName, 44)}</div>
              <div className="mt-0.5 text-xs" aria-live="polite">
                {checking ? (
                  <span className="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]"><Spinner size={12} /> Checking…</span>
                ) : fileError ? (
                  <span role="alert" className="inline-flex items-start gap-1.5 text-[var(--color-danger)]"><TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />{fileError}</span>
                ) : size != null ? (
                  <span className="text-[var(--color-text-muted)]">
                    <span className="inline-flex items-center gap-1 font-medium text-[var(--color-success)]"><CircleCheck size={13} aria-hidden /> Share file</span>
                    {" · "}{formatBytes(size)} of encrypted notes
                  </span>
                ) : null}
              </div>
              <button type="button" data-step-focus="" disabled={checking || busy}
                      className="mt-2 cursor-pointer text-xs font-medium text-[var(--color-primary)] hover:underline disabled:cursor-default disabled:opacity-50"
                      onClick={() => void choose()}>
                Choose a different file
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
            <span aria-hidden className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-primary)]/12 text-[var(--color-primary)]"><FileUp size={20} /></span>
            <p className="text-sm font-medium">Drop a <code>.{BACKUP_EXT}</code> share file here</p>
            <p className="text-xs text-[var(--color-text-muted)]">or</p>
            <Button variant="primary" className="whitespace-nowrap" data-step-focus="" onClick={() => void choose()}>Choose file…</Button>
          </div>
        )}
      </DropZone>
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">A file someone made with "Share items". Nothing changes until you confirm.</p>
    </>
  );

  const passwordStep = (
    <form onSubmit={(e) => { e.preventDefault(); next(); }} className="flex flex-col gap-1.5 text-[13px]">
      <p className="mb-1 text-xs text-[var(--color-text-muted)]">From <span className="font-medium text-[var(--color-text)]">{middleEllipsis(fileName, 48)}</span></p>
      <label className="font-medium" htmlFor="import-share-password">Password for this file</label>
      <PasswordInput id="import-share-password" autoComplete="off" value={password} disabled={busy} data-step-focus=""
                     onChange={(e) => { setPassword(e.target.value); setError(null); }} />
      <span className="text-xs text-[var(--color-text-muted)]">The one the sender gave you. It isn't your master password.</span>
      {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    </form>
  );

  const reviewStep = info && (
    <div className="flex flex-col gap-3" data-testid="share-review">
      <p className="text-sm font-medium">
        {info.notes} {info.notes === 1 ? "note" : "notes"}
        {info.folders > 0 && <>, {info.folders} {info.folders === 1 ? "folder" : "folders"}</>}
        {info.attachments > 0 && <>, {info.attachments} {info.attachments === 1 ? "attachment" : "attachments"}</>}
      </p>
      {info.items.length > 0 && <ShareItemList items={info.items} />}
      {info.vault === "none" && <p role="alert" className="text-xs text-[var(--color-danger)]">You don't have a vault yet. Create your vault first, then import this file.</p>}
      {info.vault === "locked" && (
        <div className="flex items-center gap-2.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3 text-xs">
          <Lock size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <span className="flex-1">Unlock your vault to import.</span>
          <Button size="sm" variant="primary" className="shrink-0 whitespace-nowrap" onClick={() => void unlock()}>Unlock vault…</Button>
        </div>
      )}
      {info.problem && <p role="alert" className="text-xs text-[var(--color-danger)]">{problemText(info.problem)}</p>}
      {canImport && lines.length > 0 && (
        <ul data-testid="share-note" className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
          {lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      )}
      {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );

  const doneStep = result && (
    <div className="flex flex-col gap-2 text-[13px]" data-testid="import-done">
      <p className="font-medium">{result.added > 0 ? "The items were imported." : "Nothing was imported."}</p>
      <p className="text-xs text-[var(--color-text-muted)]">{importSummary(result)}</p>
      {result.fileDeleted && <p className="text-xs text-[var(--color-text-muted)]">The share file was deleted from this computer.</p>}
    </div>
  );

  const body = { file: fileStep, password: passwordStep, review: reviewStep, done: doneStep }[step];

  return (
    <Dialog onClose={onClose} dismissable={!busy} zClassName="z-[80]" size="md" title="Import shared items" icon={<PackageOpen size={16} />} onPrimary={primary}>
      <div ref={rootRef} className="contents" data-import-step={step}>
        <DialogBody>
          <Stepper steps={STEPS} current={step} label="Import steps" />
          {body}
        </DialogBody>
        <DialogFooter start={step === "password" || step === "review" ? <DialogButton variant="ghost" onClick={back} disabled={busy}>Back</DialogButton> : undefined}>
          {step === "done" ? (
            <DialogButton variant="primary" data-step-focus="" onClick={onClose}>Close</DialogButton>
          ) : (
            <>
              <DialogButton cancel onClick={onClose} disabled={busy}>Cancel</DialogButton>
              {step === "review"
                ? <DialogButton variant="primary" disabled={!canImport} loading={busy} loadingText="Importing…" onClick={() => void doImport()}>Import</DialogButton>
                : <DialogButton variant="primary" disabled={!canNext} loading={busy && step === "password"} loadingText="Opening…" onClick={next}>{step === "password" ? "Open" : "Next"}</DialogButton>}
            </>
          )}
        </DialogFooter>
      </div>
    </Dialog>
  );
}
