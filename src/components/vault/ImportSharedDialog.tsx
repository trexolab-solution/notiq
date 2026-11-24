import { useState } from "react";
import type { FormEvent } from "react";
import { FileUp, Lock, PackageOpen } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { useVaultStore } from "../../store/vaultStore";
import { vaultErrorMessage } from "../../lib/vault";
import { getFileName, middleEllipsis } from "../../lib/pathUtils";
import { refreshVaultUi } from "../../lib/syncSetupFlow";
import {
  importSummary, pickShareFile, problemText, shareNoteLines, vaultShareImport, vaultShareInspect,
  type ShareInfo,
} from "../../lib/vaultShare";

/**
 * Import shared items: choose a share file, type the password its sender gave you, read the short note about what
 * happens (when the items go, how often the file can be imported, that the file is deleted), then import.
 * A share only goes into a vault that exists and is open; the file itself is never restored as a vault.
 */
export function ImportSharedDialog({ onClose, initialPath }: { onClose: () => void; initialPath?: string }) {
  const [path, setPath] = useState<string | null>(initialPath ?? null);
  const [password, setPassword] = useState("");
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const choose = async () => {
    try {
      const p = await pickShareFile();
      if (p) { setPath(p); setInfo(null); setError(null); }
    } catch (e) { setError(vaultErrorMessage(e)); }
  };

  const open = async () => {
    if (!path || !password || busy) return;
    setBusy(true); setError(null);
    try { setInfo(await vaultShareInspect(path, password)); }
    catch (e) { setInfo(null); setError(vaultErrorMessage(e)); }
    finally { setBusy(false); }
  };

  const unlock = async () => {
    if (!(await useVaultStore.getState().ensureUnlocked())) return;
    void open();
  };

  const doImport = async () => {
    if (!path || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await vaultShareImport(path, password);
      setPassword("");
      await refreshVaultUi();
      toast.info(importSummary(res), { source: "Import" });
      if (res.deleteFailed) toast.warning("The share file couldn't be deleted. You can delete it yourself.", { source: "Import" });
      onClose();
    } catch (e) {
      setError(vaultErrorMessage(e));
      setBusy(false);
    }
  };

  const canImport = !!info && info.vault === "ready" && !info.problem;
  const submit = (e: FormEvent) => { e.preventDefault(); if (info) { if (canImport) void doImport(); } else void open(); };
  const lines = info ? shareNoteLines(info, Date.now()) : [];

  return (
    <Dialog title="Import shared items" icon={<PackageOpen size={16} />} size="sm" onClose={onClose} onSubmit={submit} zClassName="z-[80]">
      <DialogBody>
        <div className="flex flex-col gap-3.5">
          <div className="flex items-center gap-2 text-[13px]">
            <span className="min-w-0 flex-1 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-[var(--color-text-muted)]" title={path ?? undefined}>
              {path ? middleEllipsis(getFileName(path), 40) : "No file chosen"}
            </span>
            <Button size="sm" icon={<FileUp size={13} />} disabled={busy} onClick={() => void choose()}>{path ? "Change…" : "Choose…"}</Button>
          </div>

          {!info && (
            <label className="flex flex-col gap-1.5 text-[13px]">
              <span className="font-medium">Password for this file</span>
              <PasswordInput autoFocus={!!path} autoComplete="off" value={password} disabled={busy}
                             onChange={(e) => { setPassword(e.target.value); setError(null); }} />
              <span className="text-xs text-[var(--color-text-muted)]">The one the sender gave you. It isn't your master password.</span>
            </label>
          )}

          {info && (
            <div className="flex flex-col gap-2.5" data-testid="share-review">
              <p className="text-[13px]">
                {info.notes} {info.notes === 1 ? "note" : "notes"}
                {info.folders > 0 && <>, {info.folders} {info.folders === 1 ? "folder" : "folders"}</>}
                {info.attachments > 0 && <>, {info.attachments} {info.attachments === 1 ? "attachment" : "attachments"}</>}
              </p>
              {info.vault === "none" && (
                <p role="alert" className="text-xs text-[var(--color-danger)]">You don't have a vault yet. Create your vault first, then import this file.</p>
              )}
              {info.vault === "locked" && (
                <div className="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
                  <span className="flex-1">Unlock your vault to import.</span>
                  <Button size="sm" icon={<Lock size={13} />} onClick={() => void unlock()}>Unlock</Button>
                </div>
              )}
              {info.problem && <p role="alert" className="text-xs text-[var(--color-danger)]">{problemText(info.problem)}</p>}
              {canImport && lines.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                  {lines.map((l) => <li key={l}>{l}</li>)}
                </ul>
              )}
            </div>
          )}
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        {info
          ? <DialogButton variant="primary" type="submit" disabled={!canImport || busy}>{busy ? "Importing…" : "Import"}</DialogButton>
          : <DialogButton variant="primary" type="submit" disabled={!path || !password || busy}>{busy ? "Opening…" : "Open"}</DialogButton>}
      </DialogFooter>
    </Dialog>
  );
}
