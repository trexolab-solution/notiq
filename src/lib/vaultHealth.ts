import { ensureVaultDir } from "./vaultDir";
import { ERR_LOCKED, vaultList, vaultReadFile } from "./vault";
import { normRel, toFull } from "./vaultTree";
import { hostOf, LOGIN_EXT, loginUrls, parseLogin, type LoginEntry } from "./loginEntry";
import { COMMON_PASSWORDS } from "./commonPasswords";

/**
 * Password health — runs entirely on this device. Nothing here touches the network,
 * and no report field ever contains a password (reuse is found by comparing SHA-256
 * digests that live only inside `analyzeHealth`).
 */

// ─── Strength estimate ────────────────────────────────────────────────────────

export interface Strength {
  /** Rough guessing entropy in bits after pattern penalties. */
  bits: number;
  /** 0 (very weak) … 4 (strong). */
  score: 0 | 1 | 2 | 3 | 4;
  /** Matches (or is a light variation of) a very common password. */
  common: boolean;
}

export const WEAK_MIN_LENGTH = 10;
export const WEAK_MAX_BITS = 40;

const ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

/** Next to each other on a keyboard row, or neighbours in the alphabet / digits. */
function adjacent(a: string, b: string): boolean {
  if (Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) === 1 && /[a-z0-9]/.test(a) && /[a-z0-9]/.test(b)) return true;
  return ROWS.some((r) => { const i = r.indexOf(a), j = r.indexOf(b); return i >= 0 && j >= 0 && Math.abs(i - j) === 1; });
}

const LEET: Record<string, string> = { "@": "a", "4": "a", "0": "o", "1": "i", "3": "e", "$": "s", "5": "s", "7": "t", "!": "i" };

function isCommon(lower: string): boolean {
  if (COMMON_PASSWORDS.has(lower)) return true;
  const unleet = [...lower].map((c) => LEET[c] ?? c).join("");
  const unleetL = lower.replace(/1/g, "l");
  // "Summer2024!", "password1!" → the common word with a few digits/symbols bolted on.
  const stripped = lower.replace(/[\d\W_]+$/, "").replace(/^[\d\W_]+/, "");
  return COMMON_PASSWORDS.has(unleet) || COMMON_PASSWORDS.has(unleetL)
    || (stripped.length >= 4 && stripped !== lower && COMMON_PASSWORDS.has(stripped));
}

/** Character-class + length entropy, discounted for repeats, sequences, keyboard walks and common passwords. */
export function estimateStrength(pw: string): Strength {
  if (!pw) return { bits: 0, score: 0, common: false };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(pw)) pool += 33;
  if (/[^\x00-\x7f]/.test(pw)) pool += 100;
  pool = Math.max(pool, 10);

  const lower = pw.toLowerCase();
  const lc = [...lower];
  let eff = 0;
  for (let i = 0; i < lc.length; i++) {
    const cheap = i > 0 && (lc[i] === lc[i - 1] || adjacent(lc[i - 1], lc[i]));
    eff += cheap ? 0.25 : 1;
  }
  // A short unit repeated ("abcabcabc", "xyxyxy").
  const rep = /^(.+?)\1+$/.exec(lower);
  if (rep) eff = Math.min(eff, [...rep[1]].length + 1);

  const common = isCommon(lower);
  let bits = eff * Math.log2(pool);
  if (common) bits = Math.min(bits, 10);
  bits = Math.round(bits * 10) / 10;
  const score = (bits < 28 ? 0 : bits < 36 ? 1 : bits < 50 ? 2 : bits < 64 ? 3 : 4) as Strength["score"];
  return { bits, score, common };
}

/** Weak: shorter than 10 characters, a common password, or a low strength estimate. Empty is reported separately. */
export function isWeak(pw: string): boolean {
  if (!pw) return false;
  if ([...pw].length < WEAK_MIN_LENGTH) return true;
  const s = estimateStrength(pw);
  return s.common || s.bits < WEAK_MAX_BITS;
}

// ─── Report ───────────────────────────────────────────────────────────────────

export type HealthIssue = "weak" | "reused" | "old" | "empty" | "http";
export const HEALTH_ISSUES: HealthIssue[] = ["weak", "reused", "old", "empty", "http"];

export const OLD_AFTER_DAYS = 365;
const DAY = 86_400_000;

export interface HealthInput {
  rel: string;
  path: string;
  /** Last modified, ms since epoch (from vaultList). */
  updated: number;
  entry: Pick<LoginEntry, "title" | "url" | "urls" | "username" | "password">;
}

/** One login in the report. Deliberately has no password field. */
export interface HealthItem {
  rel: string;
  path: string;
  title: string;
  username: string;
  host: string;
  issues: HealthIssue[];
  /** 0–4, or null for an empty password. */
  strength: number | null;
  /** How many OTHER logins use the same password. */
  reusedWith: number;
  /** Index into `reusedGroups`, or -1. */
  reuseGroup: number;
  ageDays: number;
}

export interface HealthReport {
  total: number;
  items: HealthItem[];
  counts: Record<HealthIssue, number>;
  /** Groups of rels that share one password (each group ≥ 2). */
  reusedGroups: string[][];
  /** 0–100, higher is better. */
  score: number;
  checkedAt: number;
}

const WEIGHT: Record<HealthIssue, number> = { empty: 1, weak: 1, reused: 0.8, http: 0.4, old: 0.2 };

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const displayTitle = (rel: string) => (normRel(rel).split("/").pop() ?? rel).replace(/\.nqv$/i, "");

/** Builds the report. Password digests stay local to this call and are dropped when it returns. */
export async function analyzeHealth(inputs: HealthInput[], now = Date.now()): Promise<HealthReport> {
  const byHash = new Map<string, number[]>();
  for (let i = 0; i < inputs.length; i++) {
    const pw = inputs[i].entry.password;
    if (!pw) continue;
    const h = await sha256Hex(pw);
    const list = byHash.get(h);
    if (list) list.push(i); else byHash.set(h, [i]);
  }
  const groupOf = new Map<number, number>();
  const reusedGroups: string[][] = [];
  for (const idx of byHash.values()) {
    if (idx.length < 2) continue;
    const g = reusedGroups.length;
    reusedGroups.push(idx.map((i) => inputs[i].rel));
    for (const i of idx) groupOf.set(i, g);
  }
  byHash.clear();

  const counts: Record<HealthIssue, number> = { weak: 0, reused: 0, old: 0, empty: 0, http: 0 };
  let penalty = 0;
  const items = inputs.map((inp, i): HealthItem => {
    const { entry } = inp;
    const issues: HealthIssue[] = [];
    const pw = entry.password;
    if (!pw) issues.push("empty");
    else if (isWeak(pw)) issues.push("weak");
    const g = groupOf.get(i) ?? -1;
    if (g >= 0) issues.push("reused");
    const ageDays = Math.max(0, Math.floor((now - inp.updated) / DAY));
    if (inp.updated > 0 && ageDays > OLD_AFTER_DAYS) issues.push("old");
    if (loginUrls(entry).some((u) => /^http:\/\//i.test(u))) issues.push("http");
    for (const k of issues) counts[k]++;
    penalty += Math.min(1, issues.reduce((a, k) => a + WEIGHT[k], 0));
    return {
      rel: inp.rel,
      path: inp.path,
      title: entry.title || displayTitle(inp.rel),
      username: entry.username,
      host: hostOf(entry.url) || hostOf(loginUrls(entry)[0] ?? ""),
      issues,
      strength: pw ? estimateStrength(pw).score : null,
      reusedWith: g >= 0 ? reusedGroups[g].length - 1 : 0,
      reuseGroup: g,
      ageDays,
    };
  });
  const score = inputs.length ? Math.round(100 * (1 - penalty / inputs.length)) : 100;
  return { total: inputs.length, items, counts, reusedGroups, score, checkedAt: now };
}

/** Items that have `issue` (or any issue when null), worst first. */
export function itemsWithIssue(report: HealthReport, issue: HealthIssue | null): HealthItem[] {
  const list = report.items.filter((it) => (issue ? it.issues.includes(issue) : it.issues.length > 0));
  const w = (it: HealthItem) => it.issues.reduce((a, k) => a + WEIGHT[k], 0);
  return list.sort((a, b) => w(b) - w(a) || a.title.localeCompare(b.title));
}

// ─── Reading logins from the vault ────────────────────────────────────────────

export interface StoredLogin { rel: string; path: string; updated: number; entry: LoginEntry }

/**
 * Decrypts every Login entry, `batch` at a time. Stops with ERR_LOCKED as soon as
 * `isUnlocked()` turns false, so nothing is read after the vault locks.
 */
export async function readAllLogins(
  isUnlocked: () => boolean,
  onProgress?: (done: number, total: number) => void,
  batch = 20,
): Promise<{ root: string; logins: StoredLogin[] }> {
  if (!isUnlocked()) throw ERR_LOCKED;
  const root = await ensureVaultDir();
  const items = (await vaultList()).filter((i) => !i.dir && i.ext === LOGIN_EXT);
  const logins: StoredLogin[] = [];
  for (let i = 0; i < items.length; i += batch) {
    if (!isUnlocked()) throw ERR_LOCKED;
    const chunk = items.slice(i, i + batch);
    const read = await Promise.all(chunk.map(async (it) => {
      const path = toFull(root, it.rel);
      try {
        const f = await vaultReadFile(path);
        if (f.ext !== LOGIN_EXT) return null;
        return { rel: normRel(it.rel), path, updated: it.updated, entry: parseLogin(f.content) };
      } catch { return null; }
    }));
    for (const r of read) if (r) logins.push(r);
    onProgress?.(Math.min(items.length, i + batch), items.length);
  }
  return { root, logins };
}
