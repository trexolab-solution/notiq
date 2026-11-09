import { previewRows } from "./entryPreview";

/** One field of a before/after comparison of an entry (labels from `previewRows`). */
export interface FieldDiff {
  label: string;
  before: string | null;
  after: string | null;
  secret: boolean;
  status: "changed" | "added" | "removed" | "same";
}

/**
 * Field-level comparison of two stored versions of an entry, in the order of the newer version (fields
 * only the older one had come last). Fields with the same label are matched by their order.
 */
export function diffEntries(before: { ext: string; content: string }, after: { ext: string; content: string }): FieldDiff[] {
  const keyed = (rows: ReturnType<typeof previewRows>) => {
    const seen = new Map<string, number>();
    return rows.map((r) => {
      const n = seen.get(r.label) ?? 0;
      seen.set(r.label, n + 1);
      return { key: `${r.label}\u0000${n}`, ...r };
    });
  };
  const b = keyed(previewRows(before.ext, before.content));
  const a = keyed(previewRows(after.ext, after.content));
  const bBy = new Map(b.map((r) => [r.key, r]));
  const out: FieldDiff[] = a.map((r) => {
    const o = bBy.get(r.key);
    bBy.delete(r.key);
    const secret = r.secret || !!o?.secret;
    if (!o) return { label: r.label, before: null, after: r.value, secret, status: "added" };
    return { label: r.label, before: o.value, after: r.value, secret, status: o.value === r.value ? "same" : "changed" };
  });
  for (const o of bBy.values()) out.push({ label: o.label, before: o.value, after: null, secret: o.secret, status: "removed" });
  return out;
}
