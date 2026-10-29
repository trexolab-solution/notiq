/** Recovery / backup codes vault entry (file type `codes`). Pure model + state helpers. */
export interface RecoveryCode { code: string; used: boolean }
export interface CodesEntry {
  v: 1;
  kind: "codes";
  title: string;
  service: string;
  codes: RecoveryCode[];
  notes: string;
}

export const CODES_EXT = "codes";
export const MAX_CODES = 100;
const MAX_CODE_LEN = 128;

export const emptyCodes = (title = ""): CodesEntry => ({ v: 1, kind: "codes", title, service: "", codes: [], notes: "" });
export const serializeCodes = (e: CodesEntry): string => JSON.stringify(e);

export function parseCodes(raw: string): CodesEntry {
  try {
    const o = JSON.parse(raw) as Partial<CodesEntry>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const codes: RecoveryCode[] = [];
    if (Array.isArray(o.codes)) {
      for (const c of o.codes as unknown[]) {
        // Tolerate a plain string list as well as {code, used} objects.
        const code = typeof c === "string" ? c : c && typeof c === "object" ? s((c as RecoveryCode).code) : "";
        if (!code.trim()) continue;
        codes.push({ code: code.trim().slice(0, MAX_CODE_LEN), used: typeof c === "object" && (c as RecoveryCode).used === true });
        if (codes.length >= MAX_CODES) break;
      }
    }
    return { v: 1, kind: "codes", title: s(o.title), service: s(o.service), codes, notes: s(o.notes) };
  } catch {
    return emptyCodes();
  }
}

/** Splits pasted text into codes: any whitespace, newline, comma or semicolon separates them. */
export function splitCodes(text: string): string[] {
  return text.split(/[\s,;]+/).map((c) => c.trim()).filter(Boolean).map((c) => c.slice(0, MAX_CODE_LEN));
}

/** Appends new codes (skipping ones already in the list, case-insensitive) up to MAX_CODES. */
export function addCodes(list: RecoveryCode[], text: string): { codes: RecoveryCode[]; added: number; skipped: number } {
  const seen = new Set(list.map((c) => c.code.toLowerCase()));
  const out = [...list];
  let added = 0, skipped = 0;
  for (const code of splitCodes(text)) {
    if (seen.has(code.toLowerCase()) || out.length >= MAX_CODES) { skipped++; continue; }
    seen.add(code.toLowerCase());
    out.push({ code, used: false });
    added++;
  }
  return { codes: out, added, skipped };
}

export const toggleUsed = (list: RecoveryCode[], i: number): RecoveryCode[] =>
  list.map((c, j) => (j === i ? { ...c, used: !c.used } : c));

export const removeCode = (list: RecoveryCode[], i: number): RecoveryCode[] => list.filter((_, j) => j !== i);

/** Index of the first code not used yet, or -1. */
export const nextUnused = (list: RecoveryCode[]): number => list.findIndex((c) => !c.used);

export const remainingCount = (list: RecoveryCode[]): number => list.filter((c) => !c.used).length;
