/** User-defined extra fields on structured vault entries (stored as `custom: [{label,value,secret}]`). */
export interface CustomField { label: string; value: string; secret: boolean }

export const MAX_CUSTOM_FIELDS = 20;
export const MAX_CUSTOM_LABEL = 60;

/** Tolerant parse: anything that isn't an array of objects becomes []; labels are clipped, count capped. */
export function parseCustomFields(v: unknown): CustomField[] {
  if (!Array.isArray(v)) return [];
  const out: CustomField[] = [];
  for (const x of v) {
    if (!x || typeof x !== "object") continue;
    const o = x as Record<string, unknown>;
    out.push({
      label: typeof o.label === "string" ? o.label.slice(0, MAX_CUSTOM_LABEL) : "",
      value: typeof o.value === "string" ? o.value : "",
      secret: o.secret === true,
    });
    if (out.length >= MAX_CUSTOM_FIELDS) break;
  }
  return out;
}
