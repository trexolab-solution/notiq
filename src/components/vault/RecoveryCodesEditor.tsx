import { useMemo, useState } from "react";
import { ClipboardCopy, Eye, EyeOff, ListChecks, Plus, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../store";
import { useAutoHide } from "../../hooks/useAutoHide";
import { CopyIconButton } from "./CopyIconButton";
import { AttachmentsPanel } from "./AttachmentsPanel";
import { EntryHeader, SaveHint, Section, fieldLabel, textArea } from "./EntryParts";
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

  return (
    <div data-tour="editor" className="flex-1 min-h-0 overflow-y-auto bg-[var(--color-editor-bg)]">
      <div className="max-w-xl mx-auto px-6 py-8 flex flex-col gap-4 text-[var(--color-text)]">
        <EntryHeader icon={ListChecks} title="Recovery codes" tab={tab} />
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
            <ol className="flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {entry.codes.map((c, i) => (
                <li key={`${c.code}-${i}`} className={`flex items-center gap-2 px-2.5 py-1 ${i === next ? "bg-[var(--color-bg-tertiary)]" : ""}`}>
                  <input type="checkbox" checked={c.used} aria-label={`Mark code ${i + 1} as used`}
                         onChange={() => save({ ...entry, codes: toggleUsed(entry.codes, i) })}
                         className="accent-[var(--color-primary)] w-3.5 h-3.5 cursor-pointer" />
                  <span className="w-6 text-right text-[11px] text-[var(--color-text-muted)] tabular-nums">{i + 1}.</span>
                  <span className={`flex-1 min-w-0 truncate font-mono text-sm ${c.used ? "line-through text-[var(--color-text-muted)]" : ""}`}>
                    {show ? c.code : "•".repeat(Math.min(12, c.code.length))}
                  </span>
                  {c.used && <span className="text-[11px] text-[var(--color-text-muted)]">used</span>}
                  <CopyIconButton value={c.code} label={`code ${i + 1}`} />
                  <Tooltip content="Remove code">
                    <Button size="sm" variant="danger" aria-label={`Remove code ${i + 1}`} icon={<X size={12} />}
                            onClick={() => save({ ...entry, codes: removeCode(entry.codes, i) })} />
                  </Tooltip>
                </li>
              ))}
            </ol>
          )}
          <div>
            <label className={fieldLabel} htmlFor="rc-add">
              {entry.codes.length ? "Add more codes" : "Paste your codes"}
              <span className="ml-1.5 opacity-70">· one per line or separated by spaces</span>
            </label>
            <textarea id="rc-add" rows={3} value={draft} spellCheck={false} autoComplete="off"
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

        <div>
          <label className={fieldLabel} htmlFor="rc-notes">Notes</label>
          <textarea id="rc-notes" rows={3} value={entry.notes} className={textArea}
                    onChange={(e) => save({ ...entry, notes: e.target.value })} />
        </div>

        <AttachmentsPanel tab={tab} />
        <SaveHint />
      </div>
    </div>
  );
}
