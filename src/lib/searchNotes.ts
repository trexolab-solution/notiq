import type { Tab } from "../types";

/** A single matching line inside one note. */
export interface SearchMatch {
  /** 1-based line number (matches Monaco's line numbering). */
  line: number;
  /** The full raw text of the matching line (UI trims / windows it for display). */
  lineText: string;
}

/** All matches found inside one note tab. */
export interface NoteSearchResult {
  tabId: string;
  title: string;
  filePath?: string;
  /** Matching lines, capped at `maxPerNote`. */
  matches: SearchMatch[];
  /** True when the note had more matching lines than were kept. */
  truncated: boolean;
}

export interface SearchOptions {
  /** Max matching lines kept per note (default 50). Extra matches set `truncated`. */
  maxPerNote?: number;
}

/**
 * Case-insensitive, literal (non-regex) full-text search across the *content* of
 * every open note tab. One result row per matching line. Whiteboard tabs and
 * empty notes are skipped. Pure and synchronous so it can be unit-tested and run
 * on every keystroke without touching the store, disk, or Tauri.
 */
export function searchNotes(
  tabs: Tab[],
  rawQuery: string,
  opts: SearchOptions = {},
): NoteSearchResult[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const maxPerNote = opts.maxPerNote ?? 50;
  const needle = query.toLowerCase();
  const results: NoteSearchResult[] = [];

  for (const tab of tabs) {
    if (tab.kind !== "note") continue; // whiteboards have no searchable text
    const content = tab.content;
    if (!content) continue;

    const lines = content.split("\n");
    const matches: SearchMatch[] = [];
    let truncated = false;

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (!lineText.toLowerCase().includes(needle)) continue;
      if (matches.length >= maxPerNote) {
        truncated = true;
        break;
      }
      matches.push({ line: i + 1, lineText });
    }

    if (matches.length > 0) {
      results.push({
        tabId: tab.id,
        title: tab.title || "Untitled",
        filePath: tab.filePath,
        matches,
        truncated,
      });
    }
  }

  return results;
}
