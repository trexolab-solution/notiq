import { isVaultPath } from "./vault";
import { uniqueName } from "./vaultTree";

/**
 * Keeps a structured vault entry's "Name" (the `title` inside its JSON) and its
 * item name in the vault (the `.nqv` file name the sidebar shows) the same.
 * Pure helpers, no Tauri or store; unit-tested in entryName.test.ts.
 */

/** File types whose content is a JSON object with a top-level `title` (login, secret kinds, recovery codes). */
export const STRUCTURED_ENTRY_EXTS: ReadonlySet<string> = new Set([
  "login", "ssh", "secret", "card", "wifi", "identity", "codes",
]);

export const isStructuredExt = (ext?: string | null): boolean => !!ext && STRUCTURED_ENTRY_EXTS.has(ext.toLowerCase());

/** A vault tab that opens in one of the structured entry editors (not a plain Markdown vault note). */
export const isStructuredEntryTab = (tab: { filePath?: string; vaultExt?: string }): boolean =>
  isVaultPath(tab.filePath) && isStructuredExt(tab.vaultExt);

/** Longest item name we produce (matches `nameError` in vaultTree). */
export const MAX_ENTRY_NAME = 120;

/**
 * Turns a typed Name into something usable as an item name: characters a name
 * can't hold (`\ / : * ? " < > |` and control characters) become spaces, runs of
 * whitespace collapse, a trailing ".nqv" and trailing dots go, and it's cut to
 * 120 characters. Returns "" when nothing usable is left.
 */
export function sanitizeEntryName(raw: string): string {
  let n = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.nqv$/i, "")
    .replace(/[.\s]+$/, "");
  if (n.length > MAX_ENTRY_NAME) n = n.slice(0, MAX_ENTRY_NAME).trim();
  return /^\.*$/.test(n) ? "" : n;
}

/**
 * The item name an entry should have after a save.
 * - An empty (or unusable) Name keeps `current`.
 * - The same name, or only a change of letter case, is used as is.
 * - A name another item in the same folder already has gets " 2", " 3", …
 *   (the rule new items use, see `uniqueName`).
 * `siblings` are the display names in the entry's folder; `current` may be among them.
 */
export function planEntryName(title: string, current: string, siblings: Iterable<string>): string {
  const wanted = sanitizeEntryName(title);
  if (!wanted) return current;
  if (wanted.toLowerCase() === current.toLowerCase()) return wanted;
  // The entry itself never counts as a clash, so a Name that already ended up as
  // "Name 2" stays "Name 2" on the next save instead of climbing.
  const others = [...siblings].filter((s) => s.toLowerCase() !== current.toLowerCase());
  return uniqueName(wanted, others);
}

/** The `title` stored in a structured entry's JSON, or null when there is none (or it isn't JSON). */
export function entryTitleOf(content: string): string | null {
  try {
    const o: unknown = JSON.parse(content);
    if (o && typeof o === "object" && !Array.isArray(o) && typeof (o as { title?: unknown }).title === "string") {
      return (o as { title: string }).title;
    }
  } catch { /* not JSON */ }
  return null;
}

/**
 * `content` with its `title` set to `title`, every other field untouched. Content
 * that isn't a JSON object is returned unchanged.
 */
export function withEntryTitle(content: string, title: string): string {
  try {
    const o: unknown = JSON.parse(content);
    if (!o || typeof o !== "object" || Array.isArray(o)) return content;
    if ((o as { title?: unknown }).title === title) return content;
    return JSON.stringify({ ...(o as Record<string, unknown>), title });
  } catch {
    return content;
  }
}
