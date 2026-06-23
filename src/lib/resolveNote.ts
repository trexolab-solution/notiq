import type { Tab } from "../types";
import { getFileName } from "./pathUtils";

/** Normalise a string for fuzzy note-title matching */
export function normNote(s: string): string {
  return decodeURIComponent(s)
    .replace(/\\/g, "/")
    .replace(/[#?].*$/, "")   // strip URL fragment and query string
    .toLowerCase()
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ");
}

export function fileBasename(s: string): string {
  return getFileName(decodeURIComponent(s));
}

/**
 * Find the tab that best matches a markdown link href.
 * Uses three strategies in order:
 *   1. Full normalised href against tab title
 *   2. Basename of href against tab title   (handles "subfolder/note.md" → "note")
 *   3. Basename of href against tab filePath filename  (handles disk-opened files)
 *
 * Returns undefined for external URLs (http/s), mailto:, note://, and #fragments.
 */
export function resolveNoteHref(href: string, tabs: Tab[]): Tab | undefined {
  if (!href) return undefined;
  const decoded = decodeURIComponent(href);
  if (/^https?:\/\//i.test(decoded))  return undefined;
  if (decoded.startsWith("mailto:"))  return undefined;
  if (decoded.startsWith("note://"))  return undefined; // handled by wiki-link path
  if (decoded.startsWith("#"))        return undefined; // in-page fragment

  const norm  = normNote(decoded);
  const bname = fileBasename(decoded);
  const bnorm = normNote(bname);

  // 1. Full normalised href → tab title
  let tab = tabs.find((t) => normNote(t.title) === norm);
  if (tab) return tab;

  // 2. Basename of link target → tab title
  if (bname !== decoded) {
    tab = tabs.find((t) => normNote(t.title) === bnorm);
    if (tab) return tab;
  }

  // 3. Basename of link target → tab filePath filename
  return tabs.find((t) => {
    if (!t.filePath) return false;
    return normNote(fileBasename(t.filePath)) === bnorm;
  });
}
