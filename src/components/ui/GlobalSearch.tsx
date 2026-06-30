import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Search, FileText } from "lucide-react";
import type { Tab } from "../../types";
import { searchNotes, type NoteSearchResult, type SearchMatch } from "../../lib/searchNotes";

interface Props {
  tabs: Tab[];
  /** Jump to a note and reveal the matched line. */
  onJump: (tabId: string, query: string, line: number) => void;
  onClose: () => void;
}

/** Last two path segments, for a compact "folder/file.md" hint. */
function shortPath(p: string): string {
  return p.replace(/\\/g, "/").split("/").slice(-2).join("/");
}

const SNIPPET_MAX = 240;

/**
 * Render a matching line as a snippet with every occurrence of `query`
 * highlighted. Leading whitespace is dropped and very long lines are windowed
 * around the first match so the match is always visible.
 */
function renderSnippet(lineText: string, query: string): React.ReactNode {
  const needle = query.trim().toLowerCase();
  let text = lineText.replace(/^\s+/, "");
  if (!needle) return text;

  if (text.length > SNIPPET_MAX) {
    const first = text.toLowerCase().indexOf(needle);
    const start = first > 80 ? first - 60 : 0;
    text = (start > 0 ? "…" : "") + text.slice(start, start + SNIPPET_MAX);
  }

  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let from = 0;
  let key = 0;
  let i = lower.indexOf(needle, from);
  while (i !== -1) {
    if (i > from) parts.push(text.slice(from, i));
    parts.push(
      <mark key={key++} className="gsearch__hl">
        {text.slice(i, i + needle.length)}
      </mark>,
    );
    from = i + needle.length;
    i = lower.indexOf(needle, from);
  }
  parts.push(text.slice(from));
  return parts;
}

export function GlobalSearch({ tabs, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => searchNotes(tabs, query), [tabs, query]);

  // Flatten matches into a single list so arrow keys move across notes too.
  const flat = useMemo(() => {
    const arr: { result: NoteSearchResult; match: SearchMatch }[] = [];
    for (const r of results) for (const m of r.matches) arr.push({ result: r, match: m });
    return arr;
  }, [results]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Keep the active row in view.
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const jump = (item: { result: NoteSearchResult; match: SearchMatch } | undefined) => {
    if (!item) return;
    onClose();
    // Defer so the overlay unmounts before the editor steals focus.
    setTimeout(() => onJump(item.result.tabId, query, item.match.line), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); jump(flat[active]); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  const trimmed = query.trim();
  let idx = -1; // running index into the flat list, assigned as rows render

  return createPortal(
    <div
      className="cmdk-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="cmdk gsearch" role="dialog" aria-label="Search notes">
        <div className="gsearch__inputrow">
          <Search size={15} className="gsearch__icon" />
          <input
            ref={inputRef}
            className="cmdk__input gsearch__input"
            placeholder="Search across all open notes…"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="cmdk__list" ref={listRef}>
          {trimmed === "" ? (
            <div className="cmdk__empty">Type to search the content of every open note</div>
          ) : results.length === 0 ? (
            <div className="cmdk__empty">No matches for “{trimmed}”</div>
          ) : (
            <>
              <div className="gsearch__summary">
                {flat.length} match{flat.length === 1 ? "" : "es"} in {results.length} note
                {results.length === 1 ? "" : "s"}
              </div>

              {results.map((r) => (
                <div key={r.tabId} className="gsearch__group">
                  <div className="gsearch__file">
                    <FileText size={13} className="gsearch__fileicon" />
                    <span className="gsearch__filename">{r.title}</span>
                    {r.filePath && <span className="gsearch__filepath">{shortPath(r.filePath)}</span>}
                    <span className="gsearch__count">
                      {r.matches.length}{r.truncated ? "+" : ""}
                    </span>
                  </div>

                  {r.matches.map((m) => {
                    idx += 1;
                    const myIdx = idx;
                    return (
                      <button
                        key={`${r.tabId}:${m.line}`}
                        type="button"
                        data-idx={myIdx}
                        className={`gsearch__match${myIdx === active ? " is-active" : ""}`}
                        onMouseEnter={() => setActive(myIdx)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => jump({ result: r, match: m })}
                      >
                        <span className="gsearch__line">{m.line}</span>
                        <span className="gsearch__snippet">{renderSnippet(m.lineText, query)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
