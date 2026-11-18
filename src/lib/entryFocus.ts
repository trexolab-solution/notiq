/**
 * A vault entry that was just created from the sidebar or the New menu opens straight in its form with
 * the Name field focused (the name is part of the form, so there is no separate rename step first).
 * Creation marks the path; the editor that mounts for it takes the mark and focuses its Name field.
 */

const norm = (p: string) => p.split("\\").join("/").toLowerCase();
const pending = new Set<string>();

export function markNewEntry(path: string): void {
  pending.add(norm(path));
}

/** True once per marked path (the mark is used up). */
export function takeNewEntry(path: string | undefined): boolean {
  return !!path && pending.delete(norm(path));
}

// ── "open this entry and put the cursor in that field" (Vault health → Fix) ──────────────────────────

/** Fired when a field focus is requested, for an editor that is already open and would not remount. */
export const ENTRY_FOCUS_EVENT = "vault:entry-focus";
const wanted = new Map<string, string>();

/** Asks the editor of `path` to focus the field with DOM id `fieldId` (as soon as it shows the entry). */
export function requestEntryFocus(path: string, fieldId: string): void {
  wanted.set(norm(path), fieldId);
  try { window.dispatchEvent(new Event(ENTRY_FOCUS_EVENT)); } catch { /* no window (tests) */ }
}

/** The field id requested for `path`, once (the request is used up). */
export function takeEntryFocus(path: string | undefined): string | null {
  if (!path) return null;
  const k = norm(path);
  const id = wanted.get(k) ?? null;
  wanted.delete(k);
  return id;
}
