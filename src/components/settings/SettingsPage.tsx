import React, { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, SearchX } from "lucide-react";
import { useAppStore } from "../../store";
import { SECTION_LABELS, SECTION_ORDER, settingDomId, type SectionId } from "../../lib/settingsIndex";
import { ALL_SETTINGS } from "../../lib/settingsRegistry";
import { sectionMatchCounts, visibleSections } from "../../lib/settingsSearch";
import { requestRunAIOnboarding } from "../../lib/settingsEvents";
import type { SettingsTarget } from "../../lib/tabKinds";
import { toast } from "../../lib/toast";
import { SettingsQueryContext, queryTokens } from "./settingsFilter";
import { observeSections } from "./scrollSpy";
import { SettingsNav } from "./SettingsNav";
import { SettingsSearchBox } from "./SettingsSearchBox";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { GeneralSection }          from "../ui/settings/GeneralSection";
import { EditorSettingsSection }   from "../ui/settings/EditorSettingsSection";
import { AISettingsSection }       from "../ui/settings/AISettingsSection";
import { VaultSection }            from "../ui/settings/VaultSection";
import { TerminalSettingsSection } from "../ui/settings/TerminalSettingsSection";
import { AppearanceSection }       from "../ui/settings/AppearanceSection";
import { ShortcutsSection }        from "../ui/settings/ShortcutsSection";
import { UpdatesSection }          from "../ui/settings/UpdatesSection";
import { AboutSection }            from "../ui/settings/AboutSection";

/** "Run setup again" in the AI section re-opens the onboarding wizard (listened for in useAppStartup). */
const AISection = () => <AISettingsSection onRunSetup={requestRunAIOnboarding} />;

const SECTION_COMPONENTS: Record<SectionId, React.ComponentType> = {
  general: GeneralSection, editor: EditorSettingsSection, ai: AISection, vault: VaultSection,
  terminal: TerminalSettingsSection, appearance: AppearanceSection, shortcuts: ShortcutsSection,
  updates: UpdatesSection, about: AboutSection,
};

export const sectionDomId = (id: SectionId) => `settings-section-${id}`;
const headingDomId = (id: SectionId) => `settings-section-${id}-title`;

/** Below this page width the nav turns into a row of chips above the content (matches settings.css). */
const NARROW_PX = 720;
const REVEAL_MS = 1600;

/** Last deep-link request already handled. Module-level so re-mounting the page (tab switch) doesn't replay it. */
let consumedNonce = 0;

const reducedMotion = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const isTypingTarget = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable='true']"));

/** True while a modal (confirm dialog, command palette, …) owns the keyboard. */
const modalOpen = () => !!document.querySelector("[aria-modal='true'], .cmdk-overlay");

/** Moves focus to `el` without scrolling, making it programmatically focusable if needed. */
function focusQuietly(el: HTMLElement) {
  if (el.tabIndex < 0 && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

/**
 * The Settings editor tab: a sticky search bar, a section nav that follows the scroll position, and every
 * section rendered one after another. Rows and groups filter themselves from `SettingsQueryContext`; this
 * page hides whole sections that have no match and handles deep links (`settingsTarget` in the store).
 */
export function SettingsPage({ tabId }: { tabId: string }) {
  const rootRef   = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  const navRef    = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const filtering = queryTokens(deferredQuery).length > 0;
  const [active, setActive] = useState<SectionId>("general");
  const [confirmReset, setConfirmReset] = useState(false);
  const [pending, setPending] = useState<SettingsTarget | null>(null);
  const spyPausedUntil = useRef(0);

  const target           = useAppStore((s) => s.settingsTarget);
  const resetPreferences = useAppStore((s) => s.resetPreferences);
  const updateTabScroll  = useAppStore((s) => s.updateTabScroll);

  const counts = useMemo(() => (filtering ? sectionMatchCounts(ALL_SETTINGS, deferredQuery) : null), [filtering, deferredQuery]);
  const shown  = useMemo(() => visibleSections(ALL_SETTINGS, deferredQuery), [deferredQuery]);
  const total  = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;
  const noResults = filtering && shown.size === 0;

  // ── Geometry ──────────────────────────────────────────────────────────────
  /** Height covered by sticky chrome at the top of the scroller (header, plus the chip row when narrow). */
  const stickyOffset = useCallback(() => {
    const root = rootRef.current;
    const header = headerRef.current?.offsetHeight ?? 0;
    const chips = root && root.clientWidth < NARROW_PX ? navRef.current?.offsetHeight ?? 0 : 0;
    return header + chips;
  }, []);

  // Expose the header height to CSS so the sticky nav sits right under it.
  useLayoutEffect(() => {
    const root = rootRef.current, header = headerRef.current;
    if (!root || !header || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => root.style.setProperty("--settings-header-h", `${header.offsetHeight}px`));
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  const scrollToEl = useCallback((el: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - stickyOffset() - 16;
    root.scrollTo({ top: Math.max(0, top), behavior: reducedMotion() ? "auto" : "smooth" });
  }, [stickyOffset]);

  /** Scrolls to a section (or one setting in it), highlights a setting briefly and moves focus there. */
  const goTo = useCallback((section: SectionId, settingId?: string) => {
    const sectionEl = document.getElementById(sectionDomId(section));
    const rowEl = settingId ? document.getElementById(settingDomId(settingId)) : null;
    const el = rowEl ?? sectionEl;
    if (!el) return;
    spyPausedUntil.current = Date.now() + 700; // don't let the smooth scroll sweep the nav highlight
    setActive(section);
    scrollToEl(el);
    if (rowEl) {
      rowEl.classList.remove("settings-revealed");
      void rowEl.offsetWidth; // restart the animation on repeat reveals
      rowEl.classList.add("settings-revealed");
      window.setTimeout(() => rowEl.classList.remove("settings-revealed"), REVEAL_MS);
      focusQuietly(rowEl);
    } else {
      const heading = document.getElementById(headingDomId(section));
      if (heading) focusQuietly(heading);
    }
  }, [scrollToEl]);

  // ── Deep links (store `openSettings(section, settingId)`) ─────────────────
  useEffect(() => {
    if (!target || target.nonce <= consumedNonce) return;
    consumedNonce = target.nonce;
    setQuery(""); // the target must not be filtered out
    setPending(target);
  }, [target]);

  useEffect(() => {
    if (!pending || queryTokens(deferredQuery).length) return; // wait until the cleared query has rendered
    const raf = requestAnimationFrame(() => { goTo(pending.section, pending.settingId); setPending(null); });
    return () => cancelAnimationFrame(raf);
  }, [pending, deferredQuery, goTo]);

  // ── Scroll position: restored on mount, saved (debounced) into the tab ────
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const t = useAppStore.getState().settingsTarget;
    const deepLinkWaiting = !!t && t.nonce > consumedNonce;
    const saved = useAppStore.getState().tabs.find((x) => x.id === tabId)?.scrollPosition ?? 0;
    if (!deepLinkWaiting && saved > 0) root.scrollTop = saved;

    let last = root.scrollTop;
    let timer = 0;
    const onScroll = () => {
      last = root.scrollTop;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => updateTabScroll(tabId, Math.round(last)), 300);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      window.clearTimeout(timer);
      // A detached element reads scrollTop 0, so save the last value we saw.
      if (useAppStore.getState().tabs.some((x) => x.id === tabId)) updateTabScroll(tabId, Math.round(last));
    };
  }, [tabId, updateTabScroll]);

  // ── Scroll spy ────────────────────────────────────────────────────────────
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return observeSections(
      root,
      () => Array.from(root.querySelectorAll<HTMLElement>("[data-section]")),
      // A jump (nav click / deep link) leaves the target heading ~one heading-height below the header, so the
      // reading line sits a little under the header: that section must already count as current.
      () => stickyOffset() + 96,
      (id) => { if (Date.now() >= spyPausedUntil.current) setActive(id as SectionId); },
    );
  }, [shown, stickyOffset]);

  // ── Keyboard: Ctrl+F or "/" focuses the search box ───────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || modalOpen()) return;
      const ctrlF = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f";
      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !isTypingTarget(e.target);
      if (!ctrlF && !slash) return;
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const clearSearch = useCallback(() => { setQuery(""); searchRef.current?.focus(); }, []);

  const onNavSelect = useCallback((id: SectionId) => {
    if (!shown.has(id)) setQuery(""); // a section hidden by the search: show everything again
    requestAnimationFrame(() => goTo(id));
  }, [shown, goTo]);

  return (
    <SettingsQueryContext.Provider value={deferredQuery}>
      <div ref={rootRef} className={`settings-page${filtering ? " settings-filtering" : ""}`}>
        <header ref={headerRef} className="settings-topbar">
          <div className="settings-topbar-inner">
            <h1 className="settings-title">Settings</h1>
            <SettingsSearchBox ref={searchRef} value={query} onChange={setQuery} resultCount={total} />
            <button type="button" className="settings-restore" onClick={() => setConfirmReset(true)}>
              <RotateCcw size={13} aria-hidden />
              <span>Restore defaults</span>
            </button>
          </div>
        </header>

        <div className="settings-body">
          <div ref={navRef} className="settings-nav-wrap">
            <SettingsNav active={active} counts={counts} onSelect={onNavSelect} />
          </div>

          <div className="settings-content" id="settings-content">
            {SECTION_ORDER.map((id) => {
              const Section = SECTION_COMPONENTS[id];
              return (
                <section
                  key={id}
                  id={sectionDomId(id)}
                  data-section={id}
                  className="settings-section"
                  aria-labelledby={headingDomId(id)}
                  hidden={!shown.has(id)}
                >
                  <h2 id={headingDomId(id)} className="settings-section-title" tabIndex={-1}>
                    {SECTION_LABELS[id]}
                  </h2>
                  <Section />
                </section>
              );
            })}

            {noResults && (
              <div className="settings-empty">
                <SearchX size={22} aria-hidden className="settings-empty-icon" />
                <p className="settings-empty-title">No settings match “{query.trim()}”</p>
                <p className="settings-empty-hint">Try a shorter word, or a section name like “editor” or “vault”.</p>
                <button type="button" className="settings-empty-clear" onClick={clearSearch}>Clear search</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="Restore default settings?"
          message="Editor, terminal, AI and update preferences go back to their defaults, and AI is turned off. Your notes, theme, vault and saved API keys are not affected."
          confirmLabel="Restore defaults"
          danger
          onConfirm={() => {
            setConfirmReset(false);
            resetPreferences();
            toast.success("Settings restored to their defaults");
          }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </SettingsQueryContext.Provider>
  );
}
