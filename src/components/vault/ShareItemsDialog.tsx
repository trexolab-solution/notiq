import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Dices, FolderOpen, Share2, TriangleAlert } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { Input } from "../ui/Input";
import { NumberField } from "../ui/NumberField";
import { PasswordInput } from "../ui/PasswordInput";
import { Button } from "../ui/Button";
import { Stepper, useStepFocus } from "../ui/Stepper";
import { TimeLimitField } from "./TimeLimitField";
import { EntryIcon } from "./sidebar/EntryIcon";
import { displayName, entryKind } from "../../lib/vaultTree";
import { toast } from "../../lib/toast";
import { vaultErrorMessage, vaultList, type VaultItem } from "../../lib/vault";
import { formatBytes, vaultSharePreview, type SharePreview } from "../../lib/vaultBackup";
import {
  chooseAll, chosenCount, confirmProblem, coveredBy, exportShareWithDialog, FILE_EXPIRY, generateSharePassword, importsProblem, initialShareForm, ITEM_REMOVAL, itemsProblem,
  listForShare, MAX_IMPORTS, passwordProblem, rulesProblem, shareSummary, toggleChosen, type ShareForm,
} from "../../lib/shareExport";
import { getFileName, middleEllipsis } from "../../lib/pathUtils";

type Step = "items" | "rules" | "confirm" | "done";
const STEPS: { key: Step; label: string }[] = [
  { key: "items", label: "Items" }, { key: "rules", label: "Rules" }, { key: "confirm", label: "Confirm" }, { key: "done", label: "Done" },
];

/**
 * Share items, as a stepper like the restore dialog: Items (tick what to share) → Rules (the receiver's password, how
 * often the file can be imported, how long it works, how long the items stay) → Confirm (a summary and the master
 * password) → Done (where the file is, and a reminder to send the password separately from the file).
 */
export function ShareItemsDialog({ onClose, initialPaths = [] }: { onClose: () => void; initialPaths?: string[] }) {
  const [step, setStep] = useState<Step>("items");
  const [form, setForm] = useState<ShareForm>(() => initialShareForm(initialPaths));
  const [items, setItems] = useState<VaultItem[]>([]);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ path: string; bytes: number; notes: number; password: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useStepFocus(rootRef, step);

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
  const ticked = chosenCount(form.paths, shown);
  const allTicked = shown.length > 0 && ticked === shown.length;
  const itemsBlock = itemsProblem(form) ?? previewError;
  const rulesBlock = rulesProblem(form);
  const confirmBlock = confirmProblem(form);
  const canNext = step === "items" ? !itemsBlock : step === "rules" ? !rulesBlock : false;

  const index = STEPS.findIndex((s) => s.key === step);
  const next = () => { if (canNext) { setError(null); setStep(STEPS[index + 1].key); } };
  const back = () => { setError(null); setStep(STEPS[index - 1].key); };

  const save = async () => {
    if (busy || confirmBlock) return;
    setBusy(true); setError(null);
    try {
      const res = await exportShareWithDialog(form);
      if (!res) return; // the save dialog was cancelled
      setDone({ ...res, password: form.sharePassword });
      setForm((f) => ({ ...f, masterPassword: "" }));
      setStep("done");
    } catch (e) {
      setError(vaultErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); }
    catch { toast.error("Couldn't copy"); }
  };

  const primary = () => { if (step === "confirm") void save(); else next(); };

  const itemsStep = (
    <div className="flex flex-col gap-2.5">
      <p className="text-sm">Choose the notes or folders to share. A folder takes everything in it.</p>
      <Input value={query} placeholder="Search" aria-label="Search items" spellCheck={false} data-step-focus="" onChange={(e) => setQuery(e.target.value)} />
      <div className="flex items-center justify-between text-xs">
        <label className="flex cursor-pointer items-center gap-2 text-[13px]">
          <input type="checkbox" aria-label="Select all" checked={allTicked} disabled={shown.length === 0}
                 ref={(el) => { if (el) el.indeterminate = ticked > 0 && !allTicked; }}
                 onChange={(e) => set("paths", chooseAll(form.paths, shown, e.target.checked))} />
          Select all
        </label>
        <span className="text-[var(--color-text-muted)]" data-testid="share-ticked">{ticked} of {shown.length} selected</span>
      </div>
      <ul className="max-h-[220px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] py-1" data-testid="share-list">
        {shown.length === 0 && <li className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{items.length === 0 ? "Nothing in the vault yet." : "No match."}</li>}
        {shown.map((i) => {
          const parent = coveredBy(form.paths, i.rel);
          const on = form.paths.includes(i.rel) || !!parent;
          const depth = i.rel.split("/").length - 1;
          return (
            <li key={i.rel} style={{ paddingLeft: 10 + depth * 16 }} className="pr-3 hover:bg-[var(--color-bg-tertiary)]">
              <label className="flex min-w-0 cursor-pointer items-center gap-2 py-1 text-[13px]" title={parent ? `Included with ${parent}` : i.rel}>
                <input type="checkbox" checked={on} disabled={!!parent} aria-label={i.rel}
                       onChange={(e) => set("paths", toggleChosen(form.paths, i.rel, e.target.checked))} />
                <EntryIcon kind={entryKind(i)} size={14} />
                <span className="truncate">{displayName(i.rel)}</span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-between gap-3 text-xs" data-testid="share-preview">
        {previewError ? (
          <span role="alert" className="inline-flex items-start gap-1.5 text-[var(--color-danger)]"><TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />{previewError}</span>
        ) : preview ? (
          <span className="text-[var(--color-text-muted)]">
            {preview.notes} {preview.notes === 1 ? "note" : "notes"}
            {preview.folders > 0 && <>, {preview.folders} {preview.folders === 1 ? "folder" : "folders"}</>}
            {form.attachments && preview.attachments > 0 && <> · {preview.attachments} {preview.attachments === 1 ? "attachment" : "attachments"} ({formatBytes(preview.attachmentBytes)})</>}
          </span>
        ) : <span className="text-[var(--color-text-muted)]">Nothing chosen yet.</span>}
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[var(--color-text)]">
          <input type="checkbox" checked={form.attachments} onChange={(e) => set("attachments", e.target.checked)} />
          Include attachments
        </label>
      </div>
      {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );

  const passwordError = passwordProblem(form.sharePassword);
  const importsError = importsProblem(form.maxImports);

  const rulesStep = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Receiver's password</span>
        <div className="flex items-center gap-2">
          <Input value={form.sharePassword} spellCheck={false} autoComplete="off" aria-label="Share password" aria-invalid={!!passwordError || undefined} maxLength={64} data-step-focus=""
                 className={passwordError ? "!border-[var(--color-danger)]" : ""} onChange={(e) => set("sharePassword", e.target.value)} />
          <Button size="sm" variant="ghost" icon={<Dices size={13} />} onClick={() => set("sharePassword", generateSharePassword())}>New</Button>
          <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} onClick={() => void copy(form.sharePassword)}>{copied ? "Copied" : "Copy"}</Button>
        </div>
        {passwordError
          ? <span role="alert" className="text-xs text-[var(--color-danger)]">{passwordError}</span>
          : <span className="text-xs text-[var(--color-text-muted)]">The receiver types this to open the file. It is not your master password.</span>}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Number of imports</span>
        <NumberField label="Number of imports" value={form.maxImports} min={1} max={MAX_IMPORTS} width={128} onChange={(n) => set("maxImports", n)} />
        {importsError
          ? <span role="alert" className="text-xs text-[var(--color-danger)]">{importsError}</span>
          : <span className="text-xs text-[var(--color-text-muted)]">How many times the file can be imported (1 to {MAX_IMPORTS}).</span>}
      </div>

      <TimeLimitField label={FILE_EXPIRY} what={FILE_EXPIRY} value={form.validFor} onChange={(v) => set("validFor", v)}
                      hint="After this, the file can't be imported." />
      <TimeLimitField label={ITEM_REMOVAL} what={ITEM_REMOVAL} value={form.itemLife} onChange={(v) => set("itemLife", v)}
                      hint={form.itemLife.mode === "at" ? "At this time the items are removed from the receiver's vault, whenever they import." : "Counted from the import. Then the items are removed from the receiver's vault."} />

      <label className="flex cursor-pointer items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={form.deleteFile} onChange={(e) => set("deleteFile", e.target.checked)} />
        <span>Delete the file after its last import</span>
      </label>
    </div>
  );

  const confirmStep = (
    <div className="flex flex-col gap-3.5">
      <ul className="list-disc space-y-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] py-2.5 pl-7 pr-3 text-[13px]" data-testid="share-summary">
        {shareSummary(form, preview).map((l) => <li key={l}>{l}</li>)}
      </ul>
      <label className="flex flex-col gap-1.5 text-[13px]">
        <span className="font-medium">Your master password</span>
        <PasswordInput autoComplete="current-password" value={form.masterPassword} aria-label="Master password" data-step-focus="" disabled={busy}
                       onChange={(e) => { set("masterPassword", e.target.value); setError(null); }} />
        <span className="text-xs text-[var(--color-text-muted)]">Needed to share, like exporting a backup. Then you choose where to save the file.</span>
      </label>
      {form.masterPassword && confirmBlock && <p className="text-xs text-[var(--color-text-muted)]" data-testid="share-problem">{confirmBlock}</p>}
      {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
    </div>
  );

  const doneStep = done && (
    <div className="flex flex-col gap-3 text-[13px]" data-testid="share-done">
      <p className="font-medium">The share file is saved.</p>
      <p className="text-xs text-[var(--color-text-muted)]">
        {done.notes} {done.notes === 1 ? "note" : "notes"} in <span title={done.path}>{middleEllipsis(getFileName(done.path), 36)}</span> ({formatBytes(done.bytes)}).
      </p>
      <div className="flex flex-col gap-1.5">
        <span className="font-medium">Password for the receiver</span>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2.5 py-1.5 text-[12.5px]">{done.password}</code>
          <Button size="sm" icon={copied ? <Check size={13} /> : <Copy size={13} />} data-step-focus="" onClick={() => void copy(done.password)}>{copied ? "Copied" : "Copy"}</Button>
        </div>
        <span className="text-xs text-[var(--color-text-muted)]">Send the password separately from the file, another way (a call, another app). Notiq doesn't keep it.</span>
      </div>
    </div>
  );

  const body = { items: itemsStep, rules: rulesStep, confirm: confirmStep, done: doneStep }[step];

  return (
    <Dialog onClose={onClose} dismissable={!busy} zClassName="z-[80]" size="md" title="Share items" icon={<Share2 size={16} />} onPrimary={primary}>
      <div ref={rootRef} className="contents" data-share-step={step}>
        <DialogBody>
          <Stepper steps={STEPS} current={step} label="Share steps" />
          {body}
        </DialogBody>
        <DialogFooter start={step === "rules" || step === "confirm"
          ? <DialogButton variant="ghost" onClick={back} disabled={busy}>Back</DialogButton>
          : step === "done" && done ? <DialogButton variant="ghost" onClick={() => void revealItemInDir(done.path).catch(() => {})}><FolderOpen size={13} /> Show in folder</DialogButton> : undefined}>
          {step === "done" ? (
            <DialogButton variant="primary" onClick={onClose}>Done</DialogButton>
          ) : (
            <>
              <DialogButton cancel onClick={onClose} disabled={busy}>Cancel</DialogButton>
              {step === "confirm"
                ? <DialogButton variant="primary" disabled={!!confirmBlock} loading={busy} loadingText="Saving…" onClick={() => void save()}>Save share file…</DialogButton>
                : <DialogButton variant="primary" disabled={!canNext} onClick={next}>Next</DialogButton>}
            </>
          )}
        </DialogFooter>
      </div>
    </Dialog>
  );
}
