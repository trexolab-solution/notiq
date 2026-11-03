/**
 * Importing SSH key files into an SSH vault entry: what each file is, which field it goes to, and the
 * "Other key files" list that keeps every file that isn't the entry's private / public key.
 *
 * Nothing is ever dropped silently: a file that doesn't fill a field lands in the list, and a field
 * value that an import replaces is moved to the list too. Pure (no React / Tauri) for unit tests.
 */
import { analyzeKey, normalizeKey } from "./sshEntry";
import { keyFacts, sameBlob } from "./sshKeyInfo";

/** Stored in the entry's `keyFiles` field (JSON) — extra key files kept with the entry. */
export interface KeyFile { id: string; name: string; size: number; value: string }

export type KeyRole = "private" | "public" | "other";

/** Largest text file accepted as a key (keys are a few KB; this keeps logs / binaries out). */
export const MAX_KEY_FILE_BYTES = 64 * 1024;
/** Most extra files an entry keeps. */
export const MAX_KEY_FILES = 10;

const newId = () => `kf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** Tolerant parse of the `keyFiles` field: anything malformed becomes [] / is skipped. */
export function parseKeyFiles(raw: string | undefined): KeyFile[] {
  if (!raw?.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const out: KeyFile[] = [];
    v.forEach((x, i) => {
      if (!x || typeof x !== "object") return;
      const o = x as Record<string, unknown>;
      if (typeof o.value !== "string") return;
      out.push({
        id: typeof o.id === "string" && o.id ? o.id : `kf-${i}`,
        name: typeof o.name === "string" && o.name.trim() ? o.name : `Key file ${i + 1}`,
        size: typeof o.size === "number" && o.size >= 0 ? o.size : byteLength(o.value),
        value: o.value,
      });
    });
    return out;
  } catch { return []; }
}

/** Empty list → "" so entries without extra files look exactly like before. */
export const serializeKeyFiles = (files: KeyFile[]): string =>
  files.length ? JSON.stringify(files.map(({ id, name, size, value }) => ({ id, name, size, value }))) : "";

export const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Private key, public key, or anything else (config, known_hosts, a damaged key …). */
export function roleOf(name: string, text: string): KeyRole {
  const a = analyzeKey(text);
  if (a.state === "public") return "public";
  if (a.state === "ok" || a.state === "encrypted") return "private";
  // A `.pub` whose text isn't a key line is still not a usable public key.
  return name.toLowerCase().endsWith(".pub") && keyFacts(text)?.side === "public" ? "public" : "other";
}

/** Why a file read from disk can't be imported, or null. */
export function rejectReason(size: number, text: string | null): string | null {
  if (size > MAX_KEY_FILE_BYTES) return "Too large to be a key file (64 KB max)";
  if (text === null) return "Couldn't read it as text";
  if (text.includes("\0")) return "It's a binary file, not a key";
  if (!text.trim()) return "The file is empty";
  return null;
}

export interface ImportInput { name: string; size: number; value: string }
export interface ImportState { privateKey: string; publicKey: string; files: KeyFile[] }

export interface ImportResult extends ImportState {
  /** Names of the files that went into each field (for messages). */
  toPrivate: string | null;
  toPublic: string | null;
  /** Files added to the extra list. */
  added: KeyFile[];
  /** Field values an import replaced (kept in `files`). */
  displaced: KeyFile[];
  /** Files skipped because the same text is already in the entry. */
  duplicates: string[];
  /** Files that didn't fit (list full). */
  overflow: string[];
}

const same = (a: string, b: string) => normalizeKey(a) === normalizeKey(b);
const stem = (n: string) => n.replace(/\.pub$/i, "").toLowerCase();

/**
 * Sorts imported files into the entry. One private key fills (or replaces) the private key field and
 * one public key the public key field — preferring the .pub that belongs to the imported / current
 * private key (same key blob, else same file name + ".pub"). Everything else is added to the list.
 */
export function routeImport(input: ImportInput[], cur: ImportState, makeId: () => string = newId): ImportResult {
  const known = [cur.privateKey, cur.publicKey, ...cur.files.map((f) => f.value)].filter((v) => v.trim());
  const duplicates: string[] = [];
  const fresh: (ImportInput & { role: KeyRole })[] = [];
  for (const f of input) {
    if (known.some((k) => same(k, f.value)) || fresh.some((x) => same(x.value, f.value))) { duplicates.push(f.name); continue; }
    fresh.push({ ...f, role: roleOf(f.name, f.value) });
  }

  const privs = fresh.filter((f) => f.role === "private");
  const pubs = fresh.filter((f) => f.role === "public");
  const blobOf = (t: string) => keyFacts(t)?.blob ?? null;

  // Pick the private key: the one that has its public key in this import, else the first.
  const priv = privs.find((p) => pubs.some((q) => sameBlob(blobOf(p.value), blobOf(q.value)) || stem(q.name) === p.name.toLowerCase()))
    ?? privs[0] ?? null;
  const privText = priv?.value ?? cur.privateKey;
  const pub = pubs.find((q) => sameBlob(blobOf(privText), blobOf(q.value)))
    ?? (priv ? pubs.find((q) => stem(q.name) === priv.name.toLowerCase()) : undefined)
    ?? pubs[0] ?? null;

  const displaced: KeyFile[] = [];
  const keep = (name: string, value: string) => displaced.push({ id: makeId(), name, size: byteLength(value), value });
  if (priv && cur.privateKey.trim()) keep("Previous private key", cur.privateKey);
  if (pub && cur.publicKey.trim()) keep("Previous public key", cur.publicKey);

  const rest = fresh.filter((f) => f !== priv && f !== pub);
  const room = Math.max(0, MAX_KEY_FILES - cur.files.length - displaced.length);
  const added = rest.slice(0, room).map((f) => ({ id: makeId(), name: f.name, size: f.size, value: f.value }));
  const overflow = rest.slice(room).map((f) => f.name);

  return {
    privateKey: priv ? normalizeKey(priv.value) : cur.privateKey,
    publicKey: pub ? normalizeKey(pub.value).trimEnd() : cur.publicKey,
    // Displaced values are always kept, even past the soft limit: losing a key is worse than a long list.
    files: [...cur.files, ...displaced, ...added],
    toPrivate: priv?.name ?? null,
    toPublic: pub?.name ?? null,
    added, displaced, duplicates, overflow,
  };
}

/** One-line summary of an import for the live region / toast. */
export function importSummary(r: ImportResult): string {
  const parts: string[] = [];
  if (r.toPrivate) parts.push(`${r.toPrivate} set as the private key`);
  if (r.toPublic) parts.push(`${r.toPublic} set as the public key`);
  if (r.added.length) parts.push(`${r.added.length} other file${r.added.length === 1 ? "" : "s"} kept below`);
  if (r.displaced.length) parts.push("the replaced key is kept under Other key files");
  if (r.duplicates.length) parts.push(`${r.duplicates.join(", ")} already in this entry`);
  if (r.overflow.length) parts.push(`${r.overflow.join(", ")} not added (at most ${MAX_KEY_FILES} other files)`);
  const s = parts.join("; ");
  // No capitalising: the sentence usually starts with a file name, which must stay as it is.
  return s ? `${s}.` : "Nothing new to import.";
}
