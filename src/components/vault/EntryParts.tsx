import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronRight, Eye, EyeOff, History, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { EntrySaveButton } from "./EntrySaveButton";
import { HistoryPanel } from "./HistoryPanel";
import type { Tab } from "../../types";
import { clipboardClearLabel, getClipboardClearSeconds } from "../../lib/vaultPrefs";

/** Shared building blocks for the structured vault entry editors. */

export const fieldLabel = "block text-xs mb-1 text-[var(--color-text-muted)]";
export const textArea = "w-full rounded-md px-2.5 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none focus:border-[var(--color-primary)]";

/**
 * Lets the header's History button toggle the panel that `EntryLayout` renders beside the form, and
 * tells the sticky header whether the form has scrolled under it.
 */
const HistoryToggle = createContext<{ open: boolean; toggle: () => void; scrolled: boolean } | null>(null);

/**
 * Root of a structured entry editor: the form in its own scroll area on the left and, while open, the
 * History panel on the right (overlaying the form when the tab is too narrow for both).
 */
export function EntryLayout({ tab, children }: { tab: Tab; children: React.ReactNode }) {
  // Keyed by tab: an editor instance can be reused when switching between entries of the same kind.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = openFor === tab.id && !!tab.filePath;
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!open || !el) return;
    setWidth(el.clientWidth);
    const obs = new ResizeObserver(() => setWidth(el.clientWidth));
    obs.observe(el);
    return () => obs.disconnect();
  }, [open]);

  const toggle = () => setOpenFor((id) => (id === tab.id ? null : tab.id));

  return (
    <HistoryToggle.Provider value={{ open, toggle, scrolled }}>
      <div ref={rootRef} data-tour="editor" className="relative flex-1 min-h-0 flex bg-[var(--color-editor-bg)]">
        {/* `data-entry-drop`: the area files can be dropped on to attach them (AttachmentsPanel), and the
            positioned box its drop highlight is drawn over. */}
        <div data-entry-drop="" className="relative flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto"
               onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>{children}</div>
        </div>
        {open && <HistoryPanel key={tab.filePath} tab={tab} containerWidth={width} onClose={() => setOpenFor(null)} />}
      </div>
    </HistoryToggle.Provider>
  );
}

/**
 * Editor title row: kind icon + name, and Save / History on the right. It sticks to the top of the
 * form's scroll area (the negative margins widen its background over the column padding), with a
 * divider once the form has scrolled under it.
 */
export function EntryHeader({ icon: Icon, title, tab, badge }: {
  icon: LucideIcon;
  title: string;
  tab: Tab;
  /** Small label after the title (e.g. the detected card network). */
  badge?: string | null;
}) {
  const history = useContext(HistoryToggle);
  const stuck = !!history?.scrolled;
  return (
    <div data-entry-header="" className={`sticky top-0 z-20 -mx-6 px-6 -my-2 py-2 flex items-center gap-2 bg-[var(--color-editor-bg)] border-b transition-colors motion-reduce:transition-none ${
      stuck ? "border-[var(--color-border)]" : "border-transparent"}`}>
      <Icon size={18} style={{ color: "var(--color-primary)" }} />
      <h1 className="text-base font-semibold">{title}</h1>
      {badge && (
        <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
          {badge}
        </span>
      )}
      <div className="flex-1" />
      <EntrySaveButton tab={tab} />
      <Tooltip content="Earlier saved versions of this entry">
        <Button size="sm" icon={<History size={13} />} disabled={!tab.filePath || !history}
                aria-pressed={history?.open ?? false} onClick={history?.toggle}
                className="aria-pressed:bg-[var(--color-bg-tertiary)] aria-pressed:text-[var(--color-text)]">
          History
        </Button>
      </Tooltip>
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

/** The clipboard half of the save hint, from Settings → Vault → "Clear copied secrets after". */
export const clearHint = (secs: number) =>
  secs > 0 ? `Copied values are cleared from the clipboard after ${clipboardClearLabel(secs)}.` : "Copied values stay on the clipboard.";

export function SaveHint() {
  return (
    <p className="text-xs text-[var(--color-text-muted)]">
      Changes are stored in the vault when you press Save (Ctrl+S), and the item takes this Name. {clearHint(getClipboardClearSeconds())}
    </p>
  );
}
