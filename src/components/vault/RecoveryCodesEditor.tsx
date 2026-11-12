import { useMemo, useState } from "react";
import { ClipboardCopy, Eye, EyeOff, ListChecks, Plus, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useAppStore } from "../../store";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { reinsert, RowActions, rowButtonClass, RowIconButton, useAnnouncer, useLatest, useListFocus, useUndoToast } from "./ListEditor";
import { EntryHeader, EntryLayout, SaveHint, Section, fieldLabel, formColumn, textArea } from "./EntryParts";
import { copySecret } from "../../lib/secureCopy";
import { toast } from "../../lib/toast";
import {
  addCodes, MAX_CODES, nextUnused, parseCodes, remainingCount, removeCode, serializeCodes, toggleUsed, type CodesEntry,
} from "../../lib/recoveryCodes";
import type { Tab } from "../../types";

/** Recovery / backup codes: one row per code with a "used" toggle; paste many at once. */
export function RecoveryCodesEditor({ tab }: { tab: Tab }) {
  const entry = useMemo(() => parseCodes(tab.content), [tab.content]);
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const [draft, setDraft] = useState("");
  const { rootRef, focusAfter } = useListFocus();
  const { announce, region } = useAnnouncer();
  const undo = useUndoToast();
  const latest = useLatest(entry);
  const save = (next: CodesEntry) => useAppStore.getState().updateTabContent(tab.id, serializeCodes(next));

  const left = remainingCount(entry.codes);
  const next = nextUnused(entry.codes);

  const add = () => {
    const r = addCodes(entry.codes, draft);
    if (r.added === 0) { toast.warning(r.skipped ? "Those codes are already in the list" : "Paste or type at least one code"); return; }
    save({ ...entry, codes: r.codes });
    setDraft("");
    toast.info(`Added ${r.added} code${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} skipped: duplicate or over ${MAX_CODES})` : ""}`);
  };

  const remove = (i: number) => {
    const removed = entry.codes[i];
    save({ ...entry, codes: removeCode(entry.codes, i) });
    focusAfter(entry.codes.length > 1 ? { index: i } : "add");
    announce(`Removed code ${i + 1}`);
    undo(`Removed code ${i + 1}`, () => {
      const cur = latest.current;
      if (cur.codes.length >= MAX_CODES || cur.codes.some((c) => c.code === removed.code)) return;
      save({ ...cur, codes: reinsert(cur.codes, i, removed) });
      announce(`Restored code ${i + 1}`);
    });
  };

  return (
    <EntryLayout tab={tab}>
      <div ref={rootRef} className={formColumn}>
        <EntryHeader icon={ListChecks} title="Recovery codes" tab={tab} />
        {region}
        <div>
          <label className={fieldLabel} htmlFor="rc-title">Name</label>
          <Input id="rc-title" value={entry.title} onChange={(e) => save({ ...entry, title: e.target.value })} />
        </div>
        <div>
          <label className={fieldLabel} htmlFor="rc-service">Service</label>
          <Input id="rc-service" value={entry.service} placeholder="e.g. GitHub, Google, Microsoft"
                 onChange={(e) => save({ ...entry, service: e.target.value })} />
        </div>

        <Section
          title={entry.codes.length ? `Codes · ${left} of ${entry.codes.length} left` : "Codes"}
          aside={entry.codes.length > 0 && (
            <div className="flex items-center gap-1">
              <Button size="sm" aria-pressed={show} icon={show ? <EyeOff size={12} /> : <Eye size={12} />} onClick={() => setShow((v) => !v)}>
                {show ? "Hide" : "Show"}
              </Button>
              <Button size="sm" icon={<ClipboardCopy size={12} />} disabled={next < 0}
                      onClick={() => { if (next >= 0) void copySecret(entry.codes[next].code, "Next unused code"); }}>
                Copy next unused
              </Button>
            </div>
          )}
        >
          {entry.codes.length > 0 && left === 0 && (
            <p className="text-xs text-[var(--color-warning)]">Every code is used. Generate new ones on the service and paste them below.</p>
          )}
          {entry.codes.length > 0 && (
            <ol aria-label="Recovery codes" className="flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {entry.codes.map((c, i) => (
                <li key={`${c.code}-${i}`} data-list-row className={`flex items-center gap-2 px-1 py-0.5 ${i === next ? "bg-[var(--color-bg-tertiary)]" : ""}`}>
                  {/* 28px hit target around the small native checkbox */}
                  <label className="inline-flex items-center justify-center h-7 w-7 shrink-0 cursor-pointer">
                    <input type="checkbox" data-row-focus checked={c.used} aria-label={`Mark code ${i + 1} as used`}
                           onChange={() => save({ ...entry, codes: toggleUsed(entry.codes, i) })}
                           className="accent-[var(--color-primary)] w-3.5 h-3.5 cursor-pointer" />
                  </label>
                  <span className="w-6 text-right text-[11px] text-[var(--color-text-muted)] tabular-nums">{i + 1}.</span>
                  <span className={`flex-1 min-w-0 truncate font-mono text-sm ${c.used ? "line-through text-[var(--color-text-muted)]" : ""}`}>
                    {show ? c.code : "•".repeat(Math.min(12, c.code.length))}
                  </span>
                  {c.used && <span className="text-[11px] text-[var(--color-text-muted)]">used</span>}
                  <RowActions>
                    <CopyIconButton value={c.code} label={`code ${i + 1}`} className={rowButtonClass} />
                    <RowIconButton danger label={`Remove code ${i + 1}`} tooltip="Remove code" icon={<X size={13} />}
                                   onClick={() => remove(i)} />
                  </RowActions>
                </li>
              ))}
            </ol>
          )}
          <div>
            <label className={fieldLabel} htmlFor="rc-add">
              {entry.codes.length ? "Add more codes" : "Paste your codes"}
              <span className="ml-1.5 opacity-70">· one per line or separated by spaces</span>
            </label>
            <textarea id="rc-add" data-list-add rows={3} value={draft} spellCheck={false} autoComplete="off"
                      placeholder={"a1b2-c3d4\ne5f6-g7h8"} className={`${textArea} font-mono`}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } }} />
            <div className="flex justify-end mt-1">
              <Button size="sm" icon={<Plus size={12} />} disabled={!draft.trim() || entry.codes.length >= MAX_CODES} onClick={add}>
                Add codes
              </Button>
            </div>
          </div>
        </Section>

        <Section title="Notes">
          <textarea id="rc-notes" aria-label="Notes" rows={3} value={entry.notes} className={textArea}
                    onChange={(e) => save({ ...entry, notes: e.target.value })} />
        </Section>

        <AttachmentsPanel tab={tab} />
        <SaveHint />
      </div>
    </EntryLayout>
  );
}
