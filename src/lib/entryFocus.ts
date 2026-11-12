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
