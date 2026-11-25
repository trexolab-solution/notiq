import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight, CircleCheck, Eye, EyeOff, History, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { EntrySaveButton } from "./EntrySaveButton";
import { HistoryPanel } from "./HistoryPanel";
import { SyncChangeBanner, type CompareRequest } from "./SyncChangeBanner";
import type { Tab } from "../../types";
import { clipboardClearLabel, getClipboardClearSeconds } from "../../lib/vaultPrefs";

/** Shared building blocks for the structured vault entry editors. */

export const fieldLabel = "block text-xs mb-1 text-[var(--color-text-muted)]";
export const textArea = "w-full rounded-md px-2.5 py-2 text-sm bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] outline-none focus:border-[var(--color-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/40";

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
          {/* `@container`: the parts below size themselves by this area's width (it shrinks when History is open
              or the tab is narrow), not the window's. */}
          <div className="@container flex-1 min-h-0 overflow-y-auto"
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
      <div data-entry-header="" className={`sticky top-0 z-20 -mx-4 px-4 @md:-mx-6 @md:px-6 -my-2 py-2 flex items-center gap-2 bg-[var(--color-editor-bg)] border-b transition-colors motion-reduce:transition-none ${
        stuck ? "border-[var(--color-border)]" : "border-transparent"}`}>
        <Icon size={18} className="shrink-0" style={{ color: "var(--color-primary)" }} />
        <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
        {badge && (
          <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text-muted)]">
            {badge}
          </span>
        )}
        <div className="flex-1 min-w-0" />
        {tab.isDirty && (
          <span role="status" className="hidden @sm:inline-flex shrink-0 items-center h-6 px-2.5 rounded-full text-[11px] font-medium border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
            Unsaved changes
          </span>
        )}
        <EntrySaveButton tab={tab} />
        <Tooltip content="Earlier saved versions of this entry">
          <Button size="sm" icon={<History size={13} />} disabled={!tab.filePath || !history}
                  aria-label="History" aria-pressed={history?.open ?? false} onClick={history?.toggle}
                  className="shrink-0 aria-pressed:bg-[var(--color-bg-tertiary)] aria-pressed:text-[var(--color-text)]">
            {/* Icon only when the form is narrow. */}
            <span className="hidden @sm:inline">History</span>
          </Button>
        </Tooltip>
      </div>
      <SyncChangeBanner path={tab.filePath} onShowChanges={history?.compare} />
    </>
  );
}

/**
 * Whether the element is at least `min` px wide, followed live (the History panel and the tab's size change it).
 * False until measured, so the narrow layout is the default.
 */
export function useWide(min: number): [React.RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setWide(el.clientWidth >= min);
    read();
    const obs = new ResizeObserver(read);
    obs.observe(el);
    return () => obs.disconnect();
  }, [min]);
  return [ref, wide];
}

/** The form column every structured editor uses: one rhythm (24px between sections) and one width. */
export const formColumn = "max-w-xl mx-auto px-4 @md:px-6 py-6 @md:py-8 flex flex-col gap-6 text-[var(--color-text)]";

/** The bordered surface every section of an entry editor sits on. */
export const cardClass = "rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/25 p-4 @md:p-6";

/**
 * A section as a card: a heading, one muted line under it that says what the section is for (`hint`), and its
 * fields. `aside` sits beside the heading (buttons wrap under it when the form is narrow).
 */
export function Section({ title, hint, aside, children }: { title: string; hint?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className={`flex flex-col gap-4 ${cardClass}`}>
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h2 className="flex-1 min-w-[8rem] text-sm font-semibold">{title}</h2>
          {aside}
        </div>
        {hint && <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

/** One line that says whether the entry is ready to use, or what is missing. */
export function StatusBanner({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const Icon = ok ? CircleCheck : TriangleAlert;
  return (
    <div role="status" data-status-banner={ok ? "ok" : "warn"}
         className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${ok
           ? "border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-success)]"
           : "border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-[var(--color-warning)]"}`}>
      <Icon size={14} className="shrink-0" aria-hidden />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export interface NavItem { id: string; label: string; badge?: string | number }

/**
 * The section switcher: a vertical rail beside the form when it is wide, a scrolling tab bar above it when it is
 * narrow. Only the selected section is shown; the others stay mounted (hidden), so nothing is lost on a switch.
 */
export function SectionNav({ items, value, onChange, vertical, label = "Sections" }: {
  items: NavItem[]; value: string; onChange: (id: string) => void; vertical: boolean; label?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  // Tabs that don't all fit scroll sideways without a scrollbar: the edge fades while more is hidden there, and the
  // selected tab is brought into view.
  const [fade, setFade] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el || vertical) return;
    const read = () => setFade({ start: el.scrollLeft > 1, end: el.scrollWidth - el.scrollLeft - el.clientWidth > 1 });
    read();
    el.addEventListener("scroll", read, { passive: true });
    const obs = typeof ResizeObserver !== "undefined" ? new ResizeObserver(read) : null;
    obs?.observe(el);
    return () => { el.removeEventListener("scroll", read); obs?.disconnect(); };
  }, [vertical]);
  useEffect(() => {
    if (vertical) return;
    ref.current?.querySelector<HTMLElement>("[aria-current]")?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  }, [value, vertical]);
  const mask = fade.start || fade.end
    ? `linear-gradient(to right, ${fade.start ? "transparent, #000 28px" : "#000, #000 0"}, ${fade.end ? "#000 calc(100% - 28px), transparent" : "#000 100%, #000"})`
    : undefined;
  return (
    <nav ref={ref} aria-label={label} data-section-nav={vertical ? "rail" : "tabs"}
         style={vertical || !mask ? undefined : { maskImage: mask, WebkitMaskImage: mask }}
         className={vertical ? "flex flex-col gap-0.5" : "flex overflow-x-auto border-b border-[var(--color-border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"}>
      {items.map((it) => {
        const on = it.id === value;
        return (
          <button key={it.id} type="button" aria-current={on ? "page" : undefined} onClick={() => onChange(it.id)}
                  className={`cursor-pointer whitespace-nowrap text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 ${vertical
                    ? `flex items-center gap-2 text-left px-3 py-2 rounded-md ${on
                      ? "bg-[var(--color-bg-tertiary)] text-[var(--color-text)]"
                      : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)]/60"}`
                    : `shrink-0 px-3 py-2.5 border-b-2 -mb-px rounded-t ${on
                      ? "border-[var(--color-primary)] text-[var(--color-text)]"
                      : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}`}>
            {it.label}
            {!!it.badge && <span className={`text-[11px] font-normal text-[var(--color-text-muted)] ${vertical ? "ml-auto" : "ml-1"}`}>{it.badge}</span>}
          </button>
        );
      })}
    </nav>
  );
}

const SHOW_PANEL = "sectioned-form:show";

/**
 * Makes sure the section holding the element with this id is the one shown, so it can be scrolled to and focused
 * (a field in a hidden section can't take focus). Returns the element, or null when there is none.
 */
export function revealField(id: string): HTMLElement | null {
  const el = document.getElementById(id);
  const panel = el?.closest<HTMLElement>("[data-panel]");
  if (el && panel?.hidden) panel.dispatchEvent(new CustomEvent(SHOW_PANEL, { bubbles: true, detail: panel.dataset.panel }));
  return el;
}

export interface FormPanel extends NavItem {
  /** The section's content: one or more `Section` cards. */
  content: React.ReactNode;
}

/**
 * The frame of a structured entry editor that is split into sections: one section is shown at a time, picked from
 * a rail beside the form when it is wide and from a tab bar above it when it is not. Every section stays mounted
 * (hidden) while another is shown, so drafts, reveals and drops are not lost on a switch.
 *
 * `side` is a short summary or action box (e.g. an SSH command): a sticky column on the right when wide, a bar
 * pinned to the bottom when narrow. `banner` is a status line above the shown section.
 */
export function SectionedForm({ header, panels, banner, side, footer }: {
  header: React.ReactNode;
  panels: FormPanel[];
  banner?: React.ReactNode;
  side?: (wide: boolean) => React.ReactNode;
  footer?: React.ReactNode;
}) {
  const [shellRef, wide] = useWide(900);
  const [picked, setPicked] = useState(panels[0]?.id ?? "");
  // A section that went away (the list changes with the entry's kind) falls back to the first one.
  const current = panels.some((p) => p.id === picked) ? picked : panels[0]?.id ?? "";
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    const on = (e: Event) => { const id = (e as CustomEvent<string>).detail; if (id) setPicked(id); };
    el.addEventListener(SHOW_PANEL, on);
    return () => el.removeEventListener(SHOW_PANEL, on);
  }, [shellRef]);
  const nav = panels.map(({ id, label, badge }) => ({ id, label, badge }));
  const sideBox = side?.(wide) ?? null;
  return (
    <div ref={shellRef} className="min-h-full">
      <div className={wide ? "max-w-6xl mx-auto px-6 py-8 flex flex-col gap-6 text-[var(--color-text)]" : `${formColumn} min-h-full`}>
        {header}
        {!wide && <SectionNav items={nav} value={current} onChange={setPicked} vertical={false} />}
        <div className={wide ? "flex items-start gap-8" : "contents"}>
          {wide && (
            <div className="sticky top-16 w-44 shrink-0">
              <SectionNav items={nav} value={current} onChange={setPicked} vertical />
            </div>
          )}
          <div className={wide ? "flex-1 min-w-0 max-w-2xl flex flex-col gap-6" : "contents"}>
            {banner}
            {panels.map((p) => (
              <div key={p.id} data-panel={p.id} hidden={p.id !== current}><div className="flex flex-col gap-6">{p.content}</div></div>
            ))}
            {footer}
          </div>
          {wide && sideBox && <aside aria-label="Summary" className="sticky top-16 w-72 shrink-0 flex flex-col gap-4">{sideBox}</aside>}
        </div>
        {!wide && sideBox && (
          <div data-form-bar="" className="sticky bottom-0 z-10 mt-auto -mx-4 @md:-mx-6 -mb-6 @md:-mb-8 px-4 @md:px-6 py-2.5 bg-[var(--color-editor-bg)] border-t border-[var(--color-border)]">
            {sideBox}
          </div>
        )}
      </div>
    </div>
  );
}

/** A row of mutually exclusive choices that reads as one control (Password / SSH key / Both). */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-1 p-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/60">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}
                className={`flex-1 min-h-8 px-2 rounded-md text-[13px] font-medium cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 border ${o.value === value
                  ? "bg-[var(--color-bg)] text-[var(--color-text)] border-[var(--color-border)]"
                  : "text-[var(--color-text-muted)] hover:text-[var(--color-text)] border-transparent"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A group inside a section (e.g. "Password" and "Private key" under Sign in): a small title and its fields. */
export function SubGroup({ title, hint, children }: { title: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-[var(--color-border)] pt-5">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-[var(--color-text-muted)]">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * An input (or textarea) with its icon actions (copy, show / hide, …) inside its right edge, so the field uses the
 * whole row and no empty slot is left beside it. The input keeps clear of the actions by their measured width.
 * `top` pins the actions to the top corner, for a textarea.
 */
export function InputWithActions({ actions, top, children }: { actions?: React.ReactNode; top?: boolean; children: React.ReactNode }) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const [pad, setPad] = useState(0);
  const has = !!actions;
  useLayoutEffect(() => {
    const el = actionsRef.current;
    if (!has || !el) { setPad(0); return; }
    const read = () => setPad(el.offsetWidth + 8);
    read();
    if (typeof ResizeObserver === "undefined") return;
    const obs = new ResizeObserver(read);
    obs.observe(el);
    return () => obs.disconnect();
  }, [has]);
  return (
    <div className="relative min-w-0" style={has ? ({ "--act-w": `${pad}px` } as React.CSSProperties) : undefined}>
      <div className={has ? "[&>input]:pr-[var(--act-w)] [&>textarea]:pr-[var(--act-w)]" : undefined}>{children}</div>
      {has && (
        <div ref={actionsRef} data-input-actions=""
             className={`absolute right-1 flex items-center gap-0.5 ${top ? "top-1" : "top-1/2 -translate-y-1/2"} [&_button:hover:not(:disabled)]:bg-[var(--color-bg-secondary)] [&_button:hover:not(:disabled)]:text-[var(--color-text)]`}>
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * One labelled field, its actions inside the input's right edge. `hint` follows the label in muted text
 * ("· optional").
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
      <InputWithActions actions={actions}>{children}</InputWithActions>
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
              className="!p-0 h-7 w-7 justify-center shrink-0 aria-pressed:text-[var(--color-primary)]"
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
