import { useState } from "react";
import { ChevronRight, Eye, EyeOff, History, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { HistoryDialog } from "./HistoryDialog";
import type { Tab } from "../../types";

/** Shared building blocks for the structured vault entry editors. */

export const fieldLabel = "block text-xs mb-1 text-[var(--color-text-muted)]";
export const textArea = "w-full rounded-md px-2.5 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none focus:border-[var(--color-primary)]";

/** Editor title row: kind icon + name, and the History button on the right. */
export function EntryHeader({ icon: Icon, title, tab, badge }: {
  icon: LucideIcon;
  title: string;
  tab: Tab;
  /** Small label after the title (e.g. the detected card network). */
  badge?: string | null;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <Icon size={18} style={{ color: "var(--color-primary)" }} />
      <h1 className="text-base font-semibold">{title}</h1>
      {badge && (
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
          {badge}
        </span>
      )}
      <div className="flex-1" />
      <Tooltip content="Earlier saved versions of this entry">
        <Button size="sm" icon={<History size={13} />} disabled={!tab.filePath} onClick={() => setHistoryOpen(true)}>
          History
        </Button>
      </Tooltip>
      {historyOpen && <HistoryDialog tab={tab} onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}

/** Uppercase section heading with a rule, like the SSH editor's sections. */
export function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] pb-1">
        <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Section whose body can be folded away; the header shows a summary while it's closed. */
export function CollapsibleSection({ id, title, summary, open, onToggle, children }: {
  id: string; title: string; summary?: string; open: boolean; onToggle: () => void; children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        className="flex items-center gap-1.5 w-full text-left pb-1 border-b border-[var(--color-border)] cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 rounded-sm"
      >
        <ChevronRight size={13} aria-hidden className="shrink-0 transition-transform motion-reduce:transition-none" style={{ transform: open ? "rotate(90deg)" : "none" }} />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{title}</span>
        {!open && summary && <span className="ml-1 text-[11px] normal-case tracking-normal truncate opacity-70">{summary}</span>}
      </button>
      {open && <div id={id} className="flex flex-col gap-3">{children}</div>}
    </section>
  );
}

export function RevealButton({ shown, onToggle, name }: { shown: boolean; onToggle: () => void; name: string }) {
  return (
    <Tooltip content={shown ? `Hide ${name}` : `Show ${name}`}>
      <Button size="sm" aria-label={shown ? `Hide ${name}` : `Show ${name}`} aria-pressed={shown}
              icon={shown ? <EyeOff size={13} /> : <Eye size={13} />} onClick={onToggle} />
    </Tooltip>
  );
}

export function SaveHint() {
  return (
    <p className="text-xs text-[var(--color-text-muted)]">
      Saved with the vault when you save this tab (Ctrl+S). Copied values are cleared from the clipboard after 20 seconds.
    </p>
  );
}
