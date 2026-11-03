import { parentRel } from "../../../lib/vaultTree";

/** The entry/folder rel behind a row key; null for none and for virtual site-group rows ("g:"). */
export const relOfKey = (key: string | null) => (key && !key.startsWith("g:") ? key.slice(2) : null);

/**
 * Where "New item" / "New folder" create things, VS Code explorer style:
 * nothing selected → the vault root (""); a folder → inside it; an entry (or a site-group row) → its folder.
 */
export function targetFolderOf(selectedKey: string | null, isFolder: (rel: string) => boolean): string {
  if (!selectedKey) return "";
  if (selectedKey.startsWith("g:")) return parentRel(selectedKey.slice(2));
  const rel = relOfKey(selectedKey);
  if (!rel) return "";
  return isFolder(rel) ? rel : parentRel(rel);
}

/** Whether any folder (or site group) is open — drives the header's Collapse all / Expand all toggle. */
export function anyExpanded(expanded: ReadonlySet<string>, folders: readonly string[]): boolean {
  if (expanded.size === 0) return false;
  const lower = new Set(folders.map((f) => f.toLowerCase()));
  // An open folder counts; so does an open site group at the root ("@site:<domain>"). A group inside a
  // folder ("<folder>/@site:…") is only on screen when that folder is open, which already counts.
  for (const rel of expanded) {
    if (lower.has(rel.toLowerCase()) || rel.startsWith("@site:")) return true;
  }
  return false;
}
