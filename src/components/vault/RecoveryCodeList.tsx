import { useState, useSyncExternalStore } from "react";
import { ClipboardCopy, Eye, EyeOff, Plus, X } from "lucide-react";
import { Button } from "../ui/Button";
import { useAppStore } from "../../store";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { reinsert, RowActions, rowButtonClass, RowIconButton, useAnnouncer, useLatest, useListFocus, useUndoToast } from "./ListEditor";
import { Section, fieldLabel, textArea } from "./EntryParts";
import { useEntryReadOnly } from "./entryContext";
import { copySecret } from "../../lib/secureCopy";
import { toast } from "../../lib/toast";
import { addCodes, MAX_CODES, nextUnused, remainingCount, removeCode, toggleUsed, type RecoveryCode } from "../../lib/recoveryCodes";
import { getCodeDraft, setCodeDraft, subscribeCodeDrafts } from "../../lib/codeDrafts";

/** A list of recovery codes: one row per code with a "used" toggle; paste many at once. */
export function RecoveryCodeList({ tabId, title, codes, onChange }: {
  tabId: string; title: string; codes: RecoveryCode[]; onChange: (next: RecoveryCode[]) => void;
}) {
  const readOnly = useEntryReadOnly();
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);
  const draft = useSyncExternalStore(subscribeCodeDrafts, () => getCodeDraft(tabId));
  const { rootRef, focusAfter } = useListFocus();
  const { announce, region } = useAnnouncer();
  const undo = useUndoToast();
  const latest = useLatest({ codes, onChange });

  const left = remainingCount(codes);
  const next = nextUnused(codes);

  /** Text waiting in the box counts as an unsaved change, so Save is enabled and closing the tab warns. */
  const type = (text: string) => {
    setCodeDraft(tabId, text);
    const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
    if (tab && !tab.isDirty && text.trim()) useAppStore.getState().updateTabContent(tabId, tab.content);
  };

  const add = () => {
    const r = addCodes(codes, draft);
    if (r.added === 0) { toast.warning(r.skipped ? "Those codes are already in the list" : "Paste or type at least one code"); return; }
    onChange(r.codes);
    setCodeDraft(tabId, "");
    toast.info(`Added ${r.added} code${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} skipped: duplicate or over ${MAX_CODES})` : ""}`);
  };

  const remove = (i: number) => {
    const removed = codes[i];
    onChange(removeCode(codes, i));
    focusAfter(codes.length > 1 ? { index: i } : "add");
    announce(`Removed code ${i + 1}`);
    undo(`Removed code ${i + 1}`, () => {
      const cur = latest.current;
      if (cur.codes.length >= MAX_CODES || cur.codes.some((c) => c.code === removed.code)) return;
      cur.onChange(reinsert(cur.codes, i, removed));
      announce(`Restored code ${i + 1}`);
    });
  };

  return (
    <div ref={rootRef}>
      {region}
      <Section
        title={codes.length ? `${title} · ${left} of ${codes.length} left` : title}
        aside={codes.length > 0 && (
          <div className="flex items-center gap-1">
            <Button size="sm" aria-pressed={show} icon={show ? <EyeOff size={12} /> : <Eye size={12} />} onClick={() => setShow((v) => !v)}>
              {show ? "Hide" : "Show"}
            </Button>
            <Button size="sm" icon={<ClipboardCopy size={12} />} disabled={next < 0}
                    onClick={() => { if (next >= 0) void copySecret(codes[next].code, "Next unused code"); }}>
              Copy next unused
            </Button>
          </div>
        )}
      >
        {codes.length > 0 && left === 0 && (
          <p className="text-xs text-[var(--color-warning)]">Every code is used. Generate new ones on the service and paste them below.</p>
        )}
        {codes.length > 0 && (
          <ol aria-label="Recovery codes" className="flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
            {codes.map((c, i) => (
              <li key={`${c.code}-${i}`} data-list-row className={`flex items-center gap-2 px-1 py-0.5 ${i === next ? "bg-[var(--color-bg-tertiary)]" : ""}`}>
                {/* 28px hit target around the small native checkbox */}
                <label className="inline-flex items-center justify-center h-7 w-7 shrink-0 cursor-pointer">
                  <input type="checkbox" data-row-focus checked={c.used} disabled={readOnly} aria-label={`Mark code ${i + 1} as used`}
                         onChange={() => onChange(toggleUsed(codes, i))}
                         className="accent-[var(--color-primary)] w-3.5 h-3.5 cursor-pointer" />
                </label>
                <span className="w-6 text-right text-[11px] text-[var(--color-text-muted)] tabular-nums">{i + 1}.</span>
                <span className={`flex-1 min-w-0 truncate font-mono text-sm ${c.used ? "line-through text-[var(--color-text-muted)]" : ""}`}>
                  {show ? c.code : "•".repeat(Math.min(12, c.code.length))}
                </span>
                {c.used && <span className="text-[11px] text-[var(--color-text-muted)]">used</span>}
                <RowActions>
                  <CopyIconButton value={c.code} label={`code ${i + 1}`} className={rowButtonClass} />
                  {!readOnly && <RowIconButton danger label={`Remove code ${i + 1}`} tooltip="Remove code" icon={<X size={13} />}
                                 onClick={() => remove(i)} />}
                </RowActions>
              </li>
            ))}
          </ol>
        )}
        {readOnly && codes.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">No codes saved. Press Edit to add them.</p>}
        {!readOnly && (
          <div>
            <label className={fieldLabel} htmlFor="rc-add">
              {codes.length ? "Add more codes" : "Paste your codes"}
              <span className="ml-1.5 opacity-70">· one per line or separated by spaces · Save adds them too</span>
            </label>
            <textarea id="rc-add" data-list-add rows={3} value={draft} spellCheck={false} autoComplete="off"
                      placeholder={"a1b2-c3d4\ne5f6-g7h8"} className={`${textArea} font-mono`}
                      onChange={(e) => type(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } }} />
            <div className="flex justify-end mt-1">
              <Button size="sm" icon={<Plus size={12} />} disabled={!draft.trim() || codes.length >= MAX_CODES} onClick={add}>
                Add codes
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}
