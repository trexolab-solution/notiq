import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { Check, Copy, Dices, FolderOpen, Folder, FileText, Share2 } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { toast } from "../../lib/toast";
import { vaultErrorMessage, vaultList, type VaultItem } from "../../lib/vault";
import { formatBytes, vaultSharePreview, type SharePreview } from "../../lib/vaultBackup";
import {
  coveredBy, exportShareWithDialog, generateSharePassword, initialShareForm, ITEM_LIFE_OPTIONS, listForShare, MAX_IMPORTS,
  shareFormProblem, toggleChosen, VALID_FOR_OPTIONS, type ItemLife, type ShareForm, type ValidFor,
} from "../../lib/shareExport";
import { getFileName, middleEllipsis } from "../../lib/pathUtils";

const SELECT_CLASS = "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-sm text-[var(--color-text)] outline-none focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40";

/**
 * Share items: tick what to share, give the receiver a password, set the rules (how often the file can be imported,
 * how long it works, how long the items stay), confirm with the master password and save the file. The sender is told
 * to send the password separately from the file.
 */
export function ShareItemsDialog({ onClose, initialPaths = [] }: { onClose: () => void; initialPaths?: string[] }) {
  const [form, setForm] = useState<ShareForm>(() => initialShareForm(initialPaths));
  const [items, setItems] = useState<VaultItem[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ path: string; bytes: number; notes: number; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const set = <K extends keyof ShareForm>(k: K, v: ShareForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => {
    let alive = true;
    vaultList().then((l) => { if (alive) setItems(l); }).catch((e) => { if (alive) setError(vaultErrorMessage(e)); });
    return () => { alive = false; };
  }, []);

  // What the selection holds (or why it can't be shared), as it changes.
  useEffect(() => {
    if (form.paths.length === 0) { setPreview(null); setPreviewError(null); return; }
    let alive = true;
    vaultSharePreview(form.paths, form.attachments)
      .then((p) => { if (alive) { setPreview(p); setPreviewError(null); } })
      .catch((e) => { if (alive) { setPreview(null); setPreviewError(vaultErrorMessage(e)); } });
    return () => { alive = false; };
  }, [form.paths, form.attachments]);

  const shown = useMemo(() => listForShare(items, query), [items, query]);
  const problem = shareFormProblem(form) ?? previewError;

  const save = async () => {
    if (busy || problem) return;
    setBusy(true); setError(null);
    try {
      const res = await exportShareWithDialog(form);
      if (!res) { setBusy(false); return; } // the save dialog was cancelled
      setDone({ ...res, password: form.sharePassword });
      setForm((f) => ({ ...f, masterPassword: "" }));
    } catch (e) {
      setError(vaultErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void save(); };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { toast.error("Couldn't copy"); }
  };

  if (done) {
    return (
      <Dialog title="Share file saved" icon={<Share2 size={16} />} size="sm" onClose={onClose} zClassName="z-[80]">
        <DialogBody>
          <div className="flex flex-col gap-3 text-[13px]" data-testid="share-done">
            <p>{done.notes} {done.notes === 1 ? "note" : "notes"} in <span title={done.path}>{middleEllipsis(getFileName(done.path), 36)}</span> ({formatBytes(done.bytes)}).</p>
            <div className="flex flex-col gap-1.5">
              <span className="font-medium">Password for the receiver</span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-[12.5px]">{done.password}</code>
                <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void copy(done.password)}>{copied ? "Copied" : "Copy"}</Button>
              </div>
              <span className="text-xs text-[var(--color-text-muted)]">Send the password separately from the file, by another way (a call, another app). Notiq doesn't keep it.</span>
            </div>
          </div>
        </DialogBody>
        <DialogFooter start={<DialogButton variant="ghost" onClick={() => void revealItemInDir(done.path).catch(() => {})}><FolderOpen size={13} /> Show in folder</DialogButton>}>
          <DialogButton variant="primary" onClick={onClose}>Done</DialogButton>
        </DialogFooter>
      </Dialog>
    );
  }

  return (
    <Dialog title="Share items" icon={<Share2 size={16} />} size="md" onClose={onClose} onSubmit={submit} zClassName="z-[80]">
      <DialogBody>
        <div className="flex flex-col gap-4 text-[13px]">
          <section className="flex flex-col gap-2" aria-label="What to share">
            <span className="font-medium">What to share</span>
            <Input value={query} placeholder="Search" aria-label="Search items" spellCheck={false} onChange={(e) => setQuery(e.target.value)} />
            <ul className="max-h-[190px] overflow-y-auto rounded-md border border-[var(--color-border)] py-1" data-testid="share-list">
              {shown.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{items.length === 0 ? "Nothing in the vault yet." : "No match."}</li>}
              {shown.map((i) => {
                const parent = coveredBy(form.paths, i.rel);
                const on = form.paths.includes(i.rel) || !!parent;
                const depth = i.rel.split("/").length - 1;
                return (
                  <li key={i.rel} style={{ paddingLeft: 10 + depth * 14 }} className="flex items-center gap-2 py-0.5 pr-3">
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" title={parent ? `Included with ${parent}` : i.rel}>
                      <input type="checkbox" checked={on} disabled={!!parent} aria-label={i.rel}
                             onChange={(e) => set("paths", toggleChosen(form.paths, i.rel, e.target.checked))} />
                      {i.dir ? <Folder size={13} className="shrink-0 text-[var(--color-text-muted)]" /> : <FileText size={13} className="shrink-0 text-[var(--color-text-muted)]" />}
                      <span className="truncate">{getFileName(i.rel).replace(/\.nqv$/i, "")}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between gap-3 text-xs text-[var(--color-text-muted)]" data-testid="share-preview">
              {previewError ? <span role="alert" className="text-[var(--color-danger)]">{previewError}</span>
                : preview ? <span>{preview.notes} {preview.notes === 1 ? "note" : "notes"}{preview.folders > 0 && <>, {preview.folders} {preview.folders === 1 ? "folder" : "folders"}</>}{form.attachments && preview.attachments > 0 && <> · {preview.attachments} {preview.attachments === 1 ? "attachment" : "attachments"} ({formatBytes(preview.attachmentBytes)})</>}</span>
                : <span>Nothing chosen yet.</span>}
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={form.attachments} onChange={(e) => set("attachments", e.target.checked)} />
                Include attachments
              </label>
            </div>
          </section>

          <section className="flex flex-col gap-1.5" aria-label="Password for the receiver">
            <span className="font-medium">Password for the receiver</span>
            <div className="flex items-center gap-2">
              <Input value={form.sharePassword} spellCheck={false} autoComplete="off" aria-label="Share password" maxLength={64}
                     onChange={(e) => set("sharePassword", e.target.value)} />
              <Button size="sm" variant="ghost" icon={<Dices size={13} />} onClick={() => set("sharePassword", generateSharePassword())}>New</Button>
              <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void copy(form.sharePassword)}>{copied ? "Copied" : "Copy"}</Button>
            </div>
            <span className="text-xs text-[var(--color-text-muted)]">They type this to open the file. It isn't your master password. Send it separately from the file.</span>
          </section>

          <section className="grid grid-cols-2 gap-x-4 gap-y-3" aria-label="Rules">
            <label className="flex flex-col gap-1.5">
              <span className="font-medium">Can be imported</span>
              <div className="flex items-center gap-2">
                <Input type="number" min={1} max={MAX_IMPORTS} value={form.maxImports} aria-label="Imports allowed" className="w-20"
                       onChange={(e) => set("maxImports", Number(e.target.value))} />
                <span className="text-xs text-[var(--color-text-muted)]">{form.maxImports === 1 ? "time" : "times"}</span>
              </div>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium">The file works for</span>
              <select className={SELECT_CLASS} value={form.validFor} aria-label="File works for" onChange={(e) => set("validFor", e.target.value as ValidFor)}>
                {VALID_FOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="font-medium">Items stay for</span>
              <select className={SELECT_CLASS} value={form.itemLife} aria-label="Items stay for" onChange={(e) => set("itemLife", e.target.value as ItemLife)}>
                {ITEM_LIFE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <span className="text-[11px] text-[var(--color-text-muted)]">After the import, then they are removed from the receiver's vault.</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 self-end pb-5">
              <input type="checkbox" className="mt-0.5" checked={form.deleteFile} onChange={(e) => set("deleteFile", e.target.checked)} />
              <span>Delete the file after its last import</span>
            </label>
          </section>

          <label className="flex flex-col gap-1.5">
            <span className="font-medium">Your master password</span>
            <PasswordInput autoComplete="current-password" value={form.masterPassword} aria-label="Master password"
                           onChange={(e) => { set("masterPassword", e.target.value); setError(null); }} />
          </label>
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
          {!error && problem && !previewError && form.paths.length > 0 && <p className="text-xs text-[var(--color-text-muted)]" data-testid="share-problem">{problem}</p>}
        </div>
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" type="submit" disabled={!!problem || busy}>{busy ? "Saving…" : "Save share file…"}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}
