import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, ArrowUp, ArrowDown, CaseSensitive, WholeWord, Regex } from "lucide-react";

interface PreviewSearchBarProps {
  /** The scrollable container element that holds the rendered markdown */
  containerEl: HTMLElement | null;
  onClose: () => void;
}

interface SearchOpts {
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Build a global RegExp from the query + options. Throws on an invalid pattern. */
function buildRegex(query: string, { matchCase, wholeWord, useRegex }: SearchOpts): RegExp {
  let pattern = useRegex ? query : escapeRegExp(query);
  if (wholeWord) pattern = `\\b(?:${pattern})\\b`;
  return new RegExp(pattern, "g" + (matchCase ? "" : "i"));
}

// Walk all text nodes in the container and wrap matches with <mark>
function highlightMatches(container: HTMLElement, regex: RegExp | null): HTMLElement[] {
  clearHighlights(container);
  if (!regex) return [];

  const marks: HTMLElement[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);

  const textNodes: Text[] = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  for (const node of textNodes) {
    const text = node.textContent ?? "";
    if (!text) continue;

    regex.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let lastEnd = 0;
    let found = false;
    let m: RegExpExecArray | null;

    while ((m = regex.exec(text)) !== null) {
      const matchText = m[0];
      // Guard against zero-width matches (e.g. `a*`, `^`) looping forever
      if (matchText === "") {
        regex.lastIndex++;
        if (regex.lastIndex > text.length) break;
        continue;
      }
      found = true;
      if (m.index > lastEnd) frag.appendChild(document.createTextNode(text.slice(lastEnd, m.index)));
      const mark = document.createElement("mark");
      mark.className = "preview-search-match";
      mark.textContent = matchText;
      frag.appendChild(mark);
      marks.push(mark);
      lastEnd = m.index + matchText.length;
    }

    if (found) {
      if (lastEnd < text.length) frag.appendChild(document.createTextNode(text.slice(lastEnd)));
      node.parentNode?.replaceChild(frag, node);
    }
  }

  return marks;
}

function clearHighlights(container: HTMLElement) {
  const existing = container.querySelectorAll("mark.preview-search-match, mark.preview-search-active");
  existing.forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    parent.normalize(); // merge adjacent text nodes
  });
}

export const PreviewSearchBar = React.memo(function PreviewSearchBar({
  containerEl,
  onClose,
}: PreviewSearchBarProps) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<HTMLElement[]>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [regexError, setRegexError] = useState(false);
  const [focused, setFocused] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const observerRef = useRef<MutationObserver | null>(null);

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Re-highlight when query changes or container content mutates (markdown re-render)
  const [contentVersion, setContentVersion] = useState(0);
  useEffect(() => {
    if (!containerEl) return;
    const obs = new MutationObserver(() => setContentVersion((v) => v + 1));
    observerRef.current = obs;
    obs.observe(containerEl, { childList: true, subtree: true });
    return () => { obs.disconnect(); observerRef.current = null; };
  }, [containerEl]);

  useEffect(() => {
    if (!containerEl) return;
    // Pause the observer while WE mutate the DOM. highlightMatches inserts
    // <mark> nodes (childList/subtree changes); if the observer stayed live it
    // would fire on our own edits → contentVersion++ → re-highlight → fire
    // again → infinite loop that freezes the whole window. Disconnecting clears
    // any pending records, so only genuine markdown re-renders re-trigger us.
    const obs = observerRef.current;
    obs?.disconnect();

    let regex: RegExp | null = null;
    let error = false;
    if (query) {
      try { regex = buildRegex(query, { matchCase, wholeWord, useRegex }); }
      catch { error = true; }
    }
    setRegexError(error);

    const marks = highlightMatches(containerEl, error ? null : regex);
    setMatches(marks);
    setActiveIdx(marks.length > 0 ? 0 : -1);
    obs?.observe(containerEl, { childList: true, subtree: true });
  }, [query, matchCase, wholeWord, useRegex, containerEl, contentVersion]);

  // Scroll active match into view and style it
  useEffect(() => {
    matches.forEach((m) => m.classList.remove("preview-search-active"));
    if (activeIdx >= 0 && activeIdx < matches.length) {
      const mark = matches[activeIdx];
      mark.classList.add("preview-search-active");
      mark.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [activeIdx, matches]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (containerEl) clearHighlights(containerEl);
    };
  }, [containerEl]);

  const goNext = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i + 1) % matches.length);
  }, [matches.length]);

  const goPrev = useCallback(() => {
    if (matches.length === 0) return;
    setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
  }, [matches.length]);

  const handleClose = useCallback(() => {
    if (containerEl) clearHighlights(containerEl);
    onClose();
  }, [containerEl, onClose]);

  // Keyboard: Enter = next, Shift+Enter = prev, Escape = close,
  // Alt+C/W/R = toggle case / whole-word / regex (matches Monaco)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); handleClose(); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev(); else goNext();
      return;
    }
    if (e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); setMatchCase((v) => !v); }
      else if (k === "w") { e.preventDefault(); setWholeWord((v) => !v); }
      else if (k === "r") { e.preventDefault(); setUseRegex((v) => !v); }
    }
  }, [handleClose, goNext, goPrev]);

  const hasResults = matches.length > 0;
  const noResults = query.length > 0 && matches.length === 0 && !regexError;
  const errored = noResults || regexError;
  const borderColor = errored
    ? "var(--color-danger)"
    : (focused ? "var(--color-primary)" : "var(--color-border)");

  // ── Toggle button inside the input (Aa / whole-word / .*) ──────────────────
  // Inlined render helper (not a component) so the buttons don't remount on
  // every keystroke re-render.
  const renderToggle = (
    active: boolean, onToggle: () => void, title: string, icon: React.ReactNode,
  ) => (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      // preventDefault on mousedown keeps focus in the input so Enter still works
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => { onToggle(); inputRef.current?.focus(); }}
      style={{
        width: 20, height: 20, borderRadius: 3, flexShrink: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer", transition: "background 0.1s, color 0.1s, border-color 0.1s",
        border: `1px solid ${active ? "color-mix(in srgb, var(--color-primary) 60%, transparent)" : "transparent"}`,
        background: active ? "color-mix(in srgb, var(--color-primary) 22%, transparent)" : "transparent",
        color: active ? "var(--color-primary)" : "var(--color-text-muted)",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "color-mix(in srgb, var(--color-text) 10%, transparent)"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      {icon}
    </button>
  );

  // ── Flat action button (prev / next / close) ───────────────────────────────
  const actionBtn = (enabled: boolean): React.CSSProperties => ({
    width: 22, height: 22, borderRadius: 4, border: "none", flexShrink: 0,
    background: "transparent",
    color: enabled ? "var(--color-text)" : "var(--color-text-muted)",
    cursor: enabled ? "pointer" : "default",
    display: "flex", alignItems: "center", justifyContent: "center",
    opacity: enabled ? 1 : 0.4, transition: "background 0.1s, color 0.1s",
  });
  const hoverOn = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.disabled) e.currentTarget.style.background = "color-mix(in srgb, var(--color-text) 10%, transparent)";
  };
  const hoverOff = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.style.background = "transparent";
  };

  const countText = regexError
    ? "Invalid"
    : query
      ? (hasResults ? `${activeIdx + 1} of ${matches.length}` : "No results")
      : "";

  return (
    <div
      // Monaco-style floating find widget — anchored to the preview's top-right
      style={{
        position: "absolute", top: 8, right: 16, zIndex: 36,
        display: "flex", alignItems: "center", gap: 4,
        height: 34, padding: "0 4px 0 6px",
        background: "var(--color-bg-secondary)",
        border: "1px solid var(--color-border)",
        borderRadius: 6,
        boxShadow: "0 2px 14px 2px rgba(0,0,0,0.28)",
        animation: "preview-search-in 0.1s ease-out",
      }}
    >
      <style>{`
        @keyframes preview-search-in {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        mark.preview-search-match {
          background: color-mix(in srgb, var(--color-warning) 30%, transparent);
          color: inherit;
          border-radius: 2px;
          padding: 0 1px;
        }
        mark.preview-search-active {
          background: var(--color-warning) !important;
          color: #000 !important;
          outline: 2px solid var(--color-warning);
          outline-offset: 1px;
          border-radius: 2px;
        }
      `}</style>

      {/* Find input with inline toggles (Aa / whole-word / regex) */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 2,
          width: 224, height: 26, borderRadius: 4,
          paddingLeft: 8, paddingRight: 3,
          background: "var(--color-bg)",
          border: `1px solid ${borderColor}`,
          transition: "border-color 0.1s",
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Find"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, height: "100%", border: "none",
            background: "transparent", color: "var(--color-text)",
            fontSize: 12.5, outline: "none", padding: 0,
          }}
        />
        {renderToggle(matchCase, () => setMatchCase((v) => !v), "Match Case (Alt+C)", <CaseSensitive size={15} strokeWidth={1.8} />)}
        {renderToggle(wholeWord, () => setWholeWord((v) => !v), "Match Whole Word (Alt+W)", <WholeWord size={15} strokeWidth={1.8} />)}
        {renderToggle(useRegex, () => setUseRegex((v) => !v), "Use Regular Expression (Alt+R)", <Regex size={15} strokeWidth={1.8} />)}
      </div>

      {/* Match count */}
      <span style={{
        fontSize: 11, fontWeight: 500, flexShrink: 0, minWidth: 52, textAlign: "center",
        color: errored ? "var(--color-danger)" : "var(--color-text-muted)",
      }}>
        {countText}
      </span>

      {/* Prev / Next */}
      <button
        onClick={goPrev}
        disabled={!hasResults}
        title="Previous Match (Shift+Enter)"
        style={actionBtn(hasResults)}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
      >
        <ArrowUp size={14} />
      </button>
      <button
        onClick={goNext}
        disabled={!hasResults}
        title="Next Match (Enter)"
        style={actionBtn(hasResults)}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
      >
        <ArrowDown size={14} />
      </button>

      {/* Close */}
      <button
        onClick={handleClose}
        title="Close (Esc)"
        style={actionBtn(true)}
        onMouseEnter={hoverOn}
        onMouseLeave={hoverOff}
      >
        <X size={14} />
      </button>
    </div>
  );
});
