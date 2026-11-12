import { createContext, useContext, useEffect, useRef, useState } from "react";
import { ChevronRight, Eye, EyeOff, History, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { EntrySaveButton } from "./EntrySaveButton";
import { HistoryPanel } from "./HistoryPanel";
import { SyncChangeBanner, type CompareRequest } from "./SyncChangeBanner";
import type { Tab } from "../../types";
import { clipboardClearLabel, getClipboardClearSeconds } from "../../lib/vaultPrefs";

/** Shared building blocks for the structured vault entry editors. */

export const fieldLabel = "block text-xs mb-1 text-[var(--color-text-muted)]";
export const textArea = "w-full rounded-md px-2.5 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none focus:border-[var(--color-primary)]";

/**
 * Lets the header's History button toggle the panel that `EntryLayout` renders beside the form, and
 * tells the sticky header whether the form has scrolled under it.
 */
const HistoryToggle = createContext<{
  open: boolean; toggle: () => void; scrolled: boolean;
  /** Opens History comparing the version a sync replaced with the current one. */
  compare: (c: CompareRequest) => void;
} | null>(null);

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

  // "Show changes" from the sync banner: History in compare mode (for this tab only).
  const [compareReq, setCompareReq] = useState<{ tabId: string; req: CompareRequest } | null>(null);
  const comparing = open && compareReq?.tabId === tab.id ? compareReq.req : null;
  const toggle = () => { setCompareReq(null); setOpenFor((id) => (id === tab.id ? null : tab.id)); };
  const compare = (req: CompareRequest) => { setCompareReq({ tabId: tab.id, req }); setOpenFor(tab.id); };
  const close = () => { setOpenFor(null); setCompareReq(null); };

  return (
    <HistoryToggle.Provider value={{ open, toggle, scrolled, compare }}>
      <div ref={rootRef} data-tour="editor" className="relative flex-1 min-h-0 flex bg-[var(--color-editor-bg)]">
        {/* `data-entry-drop`: the area files can be dropped on to attach them (AttachmentsPanel), and the
            positioned box its drop highlight is drawn over. */}
        <div data-entry-drop="" className="relative flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 overflow-y-auto"
               onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>{children}</div>
        </div>
        {open && (
          <HistoryPanel key={tab.filePath} tab={tab} containerWidth={width} onClose={close}
                        compare={comparing} onExitCompare={() => setCompareReq(null)} />
        )}
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
    <>
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
      <SyncChangeBanner path={tab.filePath} onShowChanges={history?.compare} />
    </>
  );
}

/** The form column every structured editor uses: one rhythm (24px between sections) and one width. */
export const formColumn = "max-w-xl mx-auto px-6 py-8 flex flex-col gap-6 text-[var(--color-text)]";

/**
 * Section heading with a rule. `hint` is one muted line under the heading that says what the section is for
 * (e.g. that both a password and a key may be saved).
 */
export function Section({ title, hint, aside, children }: { title: string; hint?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1 border-b border-[var(--color-border)] pb-1.5">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{title}</h2>
          {aside}
        </div>
        {hint && <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** A group inside a section (e.g. "Password" and "Private key" under Sign in): a small title and its fields. */
export function SubGroup({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/40 p-3.5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * One labelled field. Every action sits in the same fixed-width slot to the right, so inputs of different
 * rows end at the same edge. `hint` follows the label in muted text ("· optional").
 */
export function FieldRow({ htmlFor, text, hint, children, actions, help, error, hideLabel }: {
  htmlFor: string; text: string; hint?: string; children: React.ReactNode; actions?: React.ReactNode;
  /** The group heading already names the field: keep the label for screen readers only. */
  hideLabel?: boolean;
  /** Muted line under the input. */
  help?: React.ReactNode;
  /** Replaces `help` (red). */
  error?: string | null;
}) {
  return (
    <div>
      <label className={hideLabel ? "sr-only" : fieldLabel} htmlFor={htmlFor}>
        {text}{hint && <span className="ml-1.5 opacity-70">{hint}</span>}
      </label>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">{children}</div>
        <div className="w-[68px] shrink-0 flex items-center justify-end gap-1 pt-px">{actions}</div>
      </div>
      {error ? <p className="text-xs mt-1 text-[var(--color-danger)]" role="alert">{error}</p>
        : help ? <p className="text-xs mt-1 text-[var(--color-text-muted)]">{help}</p> : null}
    </div>
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
