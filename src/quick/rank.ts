/**
 * Quick search: pure helpers (no Tauri) for the result list and for picking what Enter /
 * Ctrl+Enter copies. The list itself only ever holds non-secret metadata (see
 * `quick_search_index` in src-tauri/src/quick_search.rs).
 */
import { parseLogin } from "../lib/loginEntry";
import { parseSecret, SECRET_KINDS } from "../lib/secretEntry";
import { parseCodes } from "../lib/recoveryCodes";
import { displayName, entryKind, normRel, parentRel, type EntryKind } from "../lib/vaultTree";

/** One row as returned by `quick_search_index`. */
export interface IndexItem {
  rel: string;
  ext: string;
  tags: string[];
  starred: boolean;
  updated: number;
  /** Display host / service ("" if none). */
  host: string;
  /** Every site / host string the entry can be found by. */
  urls: string[];
}

export interface QuickResult extends IndexItem {
  name: string;
  /** Parent folder ("" at the top level). */
  folder: string;
  kind: EntryKind;
}

export const MAX_RESULTS = 50;

export function toResult(it: IndexItem): QuickResult {
  const rel = normRel(it.rel);
  return { ...it, rel, name: displayName(rel), folder: parentRel(rel), kind: entryKind({ dir: false, ext: it.ext }) };
}

/** Score of one query token against an entry (0 = no match). */
function tokenScore(r: QuickResult, t: string): number {
  const name = r.name.toLowerCase();
  let best = 0;
  const bump = (s: number) => { if (s > best) best = s; };
  if (name === t) bump(100);
  else if (name.startsWith(t)) bump(80);
  else if (name.split(/[\s\-_.@/()]+/).some((w) => w.startsWith(t))) bump(60);
  else if (name.includes(t)) bump(40);
  for (const tag of r.tags) {
    const g = tag.toLowerCase();
    if (g === t) bump(35);
    else if (g.startsWith(t)) bump(25);
  }
  const host = r.host.toLowerCase();
  if (host && (host === t || host.startsWith(t) || host.startsWith(`www.${t}`))) bump(30);
  for (const u of r.urls) if (u.toLowerCase().includes(t)) bump(20);
  if (host.includes(t)) bump(20);
  if (r.folder.toLowerCase().includes(t)) bump(10);
  return best;
}

/**
 * Filters by name / tag / url / folder (every whitespace-separated token must match somewhere)
 * and ranks the matches. An empty query lists starred entries first, then the most recently changed.
 */
export function searchEntries(items: QuickResult[], query: string, limit = MAX_RESULTS): QuickResult[] {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^#/, ""));
  if (tokens.length === 0) {
    return [...items]
      .sort((a, b) => Number(b.starred) - Number(a.starred) || b.updated - a.updated || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
  const scored: { r: QuickResult; s: number }[] = [];
  for (const r of items) {
    let total = 0;
    for (const t of tokens) {
      const s = tokenScore(r, t);
      if (s === 0) { total = 0; break; }
      total += s;
    }
    if (total > 0) scored.push({ r, s: total + (r.starred ? 5 : 0) });
  }
  scored.sort((a, b) => b.s - a.s || b.r.updated - a.r.updated || a.r.name.localeCompare(b.r.name));
  return scored.slice(0, limit).map((x) => x.r);
}

/** Moves a selection index by `delta`, wrapping around a list of `len` rows. */
export function moveSelection(index: number, delta: number, len: number): number {
  if (len <= 0) return 0;
  return (((index + delta) % len) + len) % len;
}

export interface CopyField { label: string; value: string }

/**
 * What Enter (main secret) and Ctrl+Enter (username / secondary field) copy for an entry,
 * given its decrypted content. Missing values are null.
 */
export function copyFields(ext: string, content: string): { main: CopyField | null; secondary: CopyField | null } {
  const f = (label: string, value: string | undefined): CopyField | null => (value ? { label, value } : null);
  if (ext === "login") {
    const l = parseLogin(content);
    return { main: f("Password", l.password), secondary: f("Username", l.username) };
  }
  if (ext === "ssh") {
    const s = parseSecret("ssh", content).fields;
    return {
      main: f("Password", s.password) ?? f("Key passphrase", s.passphrase),
      secondary: f("Username", s.username),
    };
  }
  if (ext === "secret") {
    const s = parseSecret("secret", content).fields;
    return { main: f("API key", s.key), secondary: f("Env variable name", s.env) };
  }
  if (ext === "codes") {
    // Recovery codes: Enter copies the next unused one (it is NOT marked used; do that in the entry).
    const c = parseCodes(content);
    const next = c.codes.find((x) => !x.used);
    return { main: f("Next recovery code", next?.code), secondary: null };
  }
  const kind = SECRET_KINDS[ext];
  if (kind) {
    // Any other structured kind: first filled secret field / first filled text field.
    const s = parseSecret(ext, content).fields;
    const sec = kind.fields.find((d) => (d.type === "secret" || d.type === "multiline-secret") && s[d.key]);
    const txt = kind.fields.find((d) => d.type === "text" && s[d.key]);
    return { main: sec ? f(sec.label, s[sec.key]) : null, secondary: txt ? f(txt.label, s[txt.key]) : null };
  }
  return { main: null, secondary: null };
}

/** Kinds Enter can copy from (others, e.g. notes, open in the main window instead). */
export const hasCopyableSecret = (kind: EntryKind) =>
  kind === "login" || kind === "ssh" || kind === "secret" || kind === "card" || kind === "wifi" || kind === "codes";
