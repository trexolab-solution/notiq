import { emptyLogin, hostOf, loginUrls, serializeLogin, type LoginEntry } from "./loginEntry";
import type { VaultItem } from "./vault";
import { ancestorsOf, childNames, joinRel, normRel, uniqueName } from "./vaultTree";

/**
 * Password CSV import: parsing, format detection, column mapping, duplicate planning
 * and a chunked, IO-injected executor (so 5000+ rows never freeze the UI).
 */

// ─── RFC 4180 parsing ─────────────────────────────────────────────────────────

export type Delimiter = "," | ";" | "\t";

/** Picks `,`, `;` or tab by counting each outside quotes on the first line. */
export function detectDelimiter(text: string): Delimiter {
  const counts: Record<Delimiter, number> = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  for (const c of text.replace(/^﻿/, "")) {
    if (c === '"') q = !q;
    else if (!q && (c === "\n" || c === "\r")) break;
    else if (!q && c in counts) counts[c as Delimiter]++;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) return "\t";
  if (counts[";"] > counts[","]) return ";";
  return ",";
}

/** Parses CSV text (quotes, doubled quotes, CR/LF/CRLF, newlines inside quotes, BOM). Blank lines are dropped. */
export function parseCsv(text: string, delimiter: Delimiter = detectDelimiter(text)): string[][] {
  const s = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endRow = () => {
    row.push(field); field = "";
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };
  while (i < s.length) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === "") { quoted = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ""; i++; continue; }
    if (c === "\r") { endRow(); i += s[i + 1] === "\n" ? 2 : 1; continue; }
    if (c === "\n") { endRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

// ─── Formats and column mapping ───────────────────────────────────────────────

export type CsvFormat = "chrome" | "bitwarden" | "keepass" | "generic";

export const FORMAT_LABEL: Record<CsvFormat, string> = {
  chrome: "Chrome / Edge / Brave",
  bitwarden: "Bitwarden",
  keepass: "KeePass",
  generic: "Other CSV",
};

export const FIELDS = ["title", "url", "username", "password", "notes", "folder", "totp"] as const;
export type Field = (typeof FIELDS)[number];
/** Column index for each field, -1 when absent. */
export type ColumnMap = Record<Field, number>;

export const FIELD_LABEL: Record<Field, string> = {
  title: "Name", url: "Website", username: "Username", password: "Password", notes: "Notes", folder: "Folder", totp: "TOTP secret",
};

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s_-]+/g, " ");
const col = (header: string[], ...names: string[]) => {
  const n = header.map(norm);
  for (const name of names) { const i = n.indexOf(name); if (i >= 0) return i; }
  return -1;
};

const SYNONYMS: Record<Field, string[]> = {
  title: ["name", "title", "account", "entry", "site name", "item name"],
  url: ["url", "login uri", "web site", "website", "site", "uri", "address", "login url", "hostname", "origin"],
  username: ["username", "login username", "login name", "user", "user name", "email", "login", "e mail"],
  password: ["password", "login password", "pass", "pwd"],
  notes: ["notes", "note", "comments", "comment", "extra", "description"],
  folder: ["folder", "group", "category", "collection", "grouping"],
  totp: ["totp", "login totp", "otp", "otpauth", "2fa", "one time password"],
};

/** Best-effort mapping for an unknown CSV by header names. */
export function guessMapping(header: string[]): ColumnMap {
  const used = new Set<number>();
  const map = {} as ColumnMap;
  for (const f of ["password", "username", "url", "title", "notes", "folder", "totp"] as Field[]) {
    const n = header.map(norm);
    let idx = -1;
    for (const name of SYNONYMS[f]) { const i = n.indexOf(name); if (i >= 0 && !used.has(i)) { idx = i; break; } }
    if (idx >= 0) used.add(idx);
    map[f] = idx;
  }
  return map;
}

export function detectFormat(header: string[]): { format: CsvFormat; map: ColumnMap } {
  const h = header.map(norm);
  const has = (...names: string[]) => names.every((x) => h.includes(x));
  if (has("login uri", "login password") && h.includes("type")) {
    return { format: "bitwarden", map: {
      title: col(header, "name"), url: col(header, "login uri"), username: col(header, "login username"),
      password: col(header, "login password"), notes: col(header, "notes"), folder: col(header, "folder"),
      totp: col(header, "login totp"),
    } };
  }
  if (has("account", "login name", "password", "web site")) {
    return { format: "keepass", map: {
      title: col(header, "account"), url: col(header, "web site"), username: col(header, "login name"),
      password: col(header, "password"), notes: col(header, "comments"), folder: col(header, "group"), totp: -1,
    } };
  }
  if (has("name", "url", "username", "password")) {
    return { format: "chrome", map: {
      title: col(header, "name"), url: col(header, "url"), username: col(header, "username"),
      password: col(header, "password"), notes: col(header, "note", "notes"), folder: -1, totp: -1,
    } };
  }
  return { format: "generic", map: guessMapping(header) };
}

/** A mapping is usable when it has a password column and either a website or a username. */
export const mappingUsable = (m: ColumnMap) => m.password >= 0 && (m.url >= 0 || m.username >= 0);

// ─── Rows → logins ────────────────────────────────────────────────────────────

export interface ImportRow {
  /** 1-based line of the record in the file (header = 1). */
  line: number;
  title: string;
  url: string;
  urls: string[];
  username: string;
  password: string;
  notes: string;
  folder: string;
  totp: string;
}

export interface SkippedRow { line: number; reason: string }

export interface ParsedImport {
  format: CsvFormat;
  header: string[];
  map: ColumnMap;
  /** Data records (header removed). */
  records: string[][];
}

export function parseImport(text: string): ParsedImport {
  const all = parseCsv(text);
  const header = all[0] ?? [];
  const { format, map } = detectFormat(header);
  return { format, header, map, records: all.slice(1) };
}

/** Bitwarden keeps several URIs comma-separated in one cell. */
function splitUris(v: string): string[] {
  return v.split(/,(?=\s*(?:[a-z][a-z0-9+.-]*:\/\/|[^\s,/]+\.[^\s,]+))/i).map((u) => u.trim()).filter(Boolean);
}

export function toImportRows(p: ParsedImport, map: ColumnMap = p.map): { rows: ImportRow[]; skipped: SkippedRow[] } {
  const rows: ImportRow[] = [];
  const skipped: SkippedRow[] = [];
  const typeCol = p.format === "bitwarden" ? col(p.header, "type") : -1;
  const fieldsCol = p.format === "bitwarden" ? col(p.header, "fields") : -1;
  p.records.forEach((r, i) => {
    const line = i + 2;
    const get = (idx: number) => (idx >= 0 ? (r[idx] ?? "").trim() : "");
    if (typeCol >= 0) {
      const t = get(typeCol).toLowerCase();
      if (t && t !== "login") { skipped.push({ line, reason: `Not a login (${t})` }); return; }
    }
    const rawUrl = map.url >= 0 ? (r[map.url] ?? "") : "";
    const all = p.format === "bitwarden" ? splitUris(rawUrl) : rawUrl.trim() ? [rawUrl.trim()] : [];
    const username = get(map.username);
    const password = map.password >= 0 ? (r[map.password] ?? "") : "";
    if (!all.length && !username && !password) { skipped.push({ line, reason: "Empty row" }); return; }
    let notes = map.notes >= 0 ? (r[map.notes] ?? "").trim() : "";
    const extra = get(fieldsCol);
    if (extra) notes = notes ? `${notes}\n\n${extra}` : extra;
    rows.push({
      line, title: get(map.title), url: all[0] ?? "", urls: all.slice(1, 21), username, password, notes,
      folder: get(map.folder), totp: get(map.totp),
    });
  });
  return { rows, skipped };
}

// ─── Planning (names, folders, duplicates) ────────────────────────────────────

export type DupPolicy = "skip" | "update" | "keep";

export interface ExistingLogin { rel: string; path: string; entry: Pick<LoginEntry, "url" | "urls" | "username" | "password"> }

/** Same site (host) + same username, case-insensitive. Null when the row has no host. */
export function dupKey(url: string, username: string): string | null {
  const h = hostOf(url);
  return h ? `${h}\n${username.trim().toLowerCase()}` : null;
}

/** File-name-safe entry / folder name (`\ / : * ? " < > |` and control characters removed). */
export function cleanName(s: string, fallback = ""): string {
  const c = s.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return c || fallback;
}

/** `Imported` + a source folder like `Work/Email` → `Imported/Work/Email` (each part cleaned). */
export function targetFolder(base: string, sourceFolder: string): string {
  const parts = [...base.split("/"), ...sourceFolder.split(/[\\/]/)].map((p) => cleanName(p)).filter(Boolean);
  return parts.join("/");
}

export interface PlanStep {
  row: ImportRow;
  action: "create" | "update" | "skip";
  /** create: the new entry's rel; update: the existing entry's rel (empty when it updates a row created earlier in this import). */
  rel: string;
  /** update of an entry already in the vault: its full path. */
  path?: string;
  reason?: string;
}

export interface PlanOptions {
  policy: DupPolicy;
  /** Folder new entries go into ("" = vault root). */
  baseFolder: string;
  /** Put rows that carry a folder (Bitwarden, KeePass groups) into `<base>/<folder>`. */
  useSourceFolders: boolean;
  /** The current vault list (names only). */
  items: VaultItem[];
  existing: ExistingLogin[];
}

export function planImport(rows: ImportRow[], o: PlanOptions): PlanStep[] {
  const index = new Map<string, { kind: "vault"; login: ExistingLogin } | { kind: "row"; step: PlanStep }>();
  for (const e of o.existing) {
    for (const u of loginUrls(e.entry)) {
      const k = dupKey(u, e.entry.username);
      if (k && !index.has(k)) index.set(k, { kind: "vault", login: e });
    }
  }
  const taken = new Map<string, Set<string>>();
  const takenIn = (folder: string) => {
    const key = folder.toLowerCase();
    let s = taken.get(key);
    if (!s) { s = new Set(childNames(o.items, folder).map((n) => n.toLowerCase())); taken.set(key, s); }
    return s;
  };

  const steps: PlanStep[] = [];
  for (const row of rows) {
    const key = dupKey(row.url, row.username);
    const hit = key ? index.get(key) : undefined;
    if (hit && o.policy !== "keep") {
      if (o.policy === "skip") {
        steps.push({ row, action: "skip", rel: "", reason: hit.kind === "vault" ? "Already in the vault" : "Duplicate row in this file" });
        continue;
      }
      if (hit.kind === "vault") {
        if (hit.login.entry.password === row.password) {
          steps.push({ row, action: "skip", rel: hit.login.rel, reason: "Same password already saved" });
        } else {
          steps.push({ row, action: "update", rel: hit.login.rel, path: hit.login.path });
        }
      } else {
        // A duplicate inside the file itself: the later row's password wins.
        hit.step.row = { ...hit.step.row, password: row.password };
        steps.push({ row, action: "skip", rel: hit.step.rel, reason: "Merged with an earlier row" });
      }
      continue;
    }
    const folder = targetFolder(o.baseFolder, o.useSourceFolders ? row.folder : "");
    const t = takenIn(folder);
    const name = uniqueName(cleanName(row.title, hostOf(row.url) || cleanName(row.username, "Imported login")), t);
    t.add(name.toLowerCase());
    const step: PlanStep = { row, action: "create", rel: joinRel(folder, `${name}.nqv`) };
    steps.push(step);
    if (key && !index.has(key)) index.set(key, { kind: "row", step });
  }
  return steps;
}

export function planCounts(steps: PlanStep[]) {
  return {
    create: steps.filter((s) => s.action === "create").length,
    update: steps.filter((s) => s.action === "update").length,
    skip: steps.filter((s) => s.action === "skip").length,
  };
}

// ─── Executing ────────────────────────────────────────────────────────────────

export interface ImportIO {
  /** Create one folder (vault-relative). Parents are created first by the executor. */
  mkdir: (rel: string) => Promise<void>;
  /** Write a new login entry at `rel`. */
  create: (rel: string, content: string) => Promise<void>;
  /** Replace only the password of the entry at `path`. */
  updatePassword: (path: string, password: string) => Promise<void>;
  /** Let the UI breathe between chunks. */
  yieldToUi?: () => Promise<void>;
  /** False aborts the run (e.g. the vault locked). */
  shouldContinue?: () => boolean;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  failed: { line: number; name: string; error: string }[];
  aborted: boolean;
}

const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
const parentOf = (rel: string) => { const n = normRel(rel); const i = n.lastIndexOf("/"); return i < 0 ? "" : n.slice(0, i); };

export function loginFromRow(row: ImportRow, name: string): LoginEntry {
  return {
    ...emptyLogin(row.title || name), url: row.url, urls: row.urls, username: row.username,
    password: row.password, notes: row.notes, totp: row.totp,
  };
}

export async function executeImport(
  steps: PlanStep[],
  existingDirs: string[],
  io: ImportIO,
  onProgress?: (done: number, total: number) => void,
  chunk = 25,
): Promise<ImportResult> {
  const res: ImportResult = { created: 0, updated: 0, skipped: 0, failed: [], aborted: false };
  const dirs = new Set(existingDirs.map((d) => normRel(d).toLowerCase()));
  const badDirs = new Set<string>();
  const ensureDir = async (folder: string): Promise<boolean> => {
    if (!folder) return true;
    for (const d of [...ancestorsOf(`${folder}/x`)]) {
      const k = d.toLowerCase();
      if (badDirs.has(k)) return false;
      if (dirs.has(k)) continue;
      try { await io.mkdir(d); dirs.add(k); } catch { badDirs.add(k); return false; }
    }
    return true;
  };

  for (let i = 0; i < steps.length; i++) {
    if (i % chunk === 0) {
      if (io.shouldContinue && !io.shouldContinue()) { res.aborted = true; break; }
      onProgress?.(i, steps.length);
      if (i > 0 && io.yieldToUi) await io.yieldToUi();
    }
    const s = steps[i];
    const name = s.rel ? s.rel.split("/").pop()!.replace(/\.nqv$/i, "") : s.row.title;
    try {
      if (s.action === "skip") { res.skipped++; continue; }
      if (s.action === "update") {
        await io.updatePassword(s.path!, s.row.password);
        res.updated++;
        continue;
      }
      const folder = parentOf(s.rel);
      if (!(await ensureDir(folder))) throw new Error(`Couldn't create the folder "${folder}"`);
      await io.create(s.rel, serializeLogin(loginFromRow(s.row, name)));
      res.created++;
    } catch (e) {
      res.failed.push({ line: s.row.line, name, error: errText(e) });
    }
  }
  if (!res.aborted) onProgress?.(steps.length, steps.length);
  return res;
}
