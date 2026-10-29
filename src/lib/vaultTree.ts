import type { VaultItem } from "./vault";

/**
 * Pure helpers behind the Secure Vault sidebar: turning the flat backend list
 * into a tree, filtering by name/tags, sorting, and path arithmetic for
 * rename/move. No React, no Tauri — unit-tested in vaultTree.test.ts.
 *
 * Vocabulary: `rel` is a path relative to the vault root using "/", notes end
 * with ".nqv"; a "full" path is `<root>/<rel>` (what tabs store as filePath).
 */

export type EntryKind = "folder" | "note" | "login" | "ssh" | "secret" | "card" | "wifi" | "codes";
export type SortMode = "name" | "modified";

export interface TreeNode {
  rel: string;
  /** Display name: last segment without ".nqv". */
  name: string;
  dir: boolean;
  kind: EntryKind;
  ext: string;
  /** For folders: the newest `updated` of anything inside. */
  updated: number;
  tags: string[];
  starred: boolean;
  depth: number;
  children: TreeNode[];
}

export interface FlatRow { node: TreeNode; depth: number }

const NQV = /\.nqv$/i;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// ── path arithmetic ──────────────────────────────────────────────────────────

export const normRel = (rel: string) => rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
export const baseName = (rel: string) => normRel(rel).split("/").pop() ?? "";
export const displayName = (rel: string) => baseName(rel).replace(NQV, "");
export function parentRel(rel: string): string {
  const r = normRel(rel);
  const i = r.lastIndexOf("/");
  return i < 0 ? "" : r.slice(0, i);
}
export const joinRel = (folder: string, name: string) => (folder ? `${normRel(folder)}/${name}` : name);

const normRoot = (root: string) => root.replace(/\\/g, "/").replace(/\/+$/, "");
/** `<root>/<rel>` — matches the shape tabs store in `filePath`. */
export const toFull = (root: string, rel: string) => `${normRoot(root)}/${normRel(rel)}`;
/** Inverse of toFull; null when `full` isn't inside `root`. Case-insensitive (Windows). */
export function toRel(root: string, full: string): string | null {
  const r = normRoot(root);
  const f = full.replace(/\\/g, "/");
  if (f.toLowerCase().startsWith(r.toLowerCase() + "/")) return normRel(f.slice(r.length + 1));
  return null;
}

/** True when `path` is `prefix` itself or lies inside it (case-insensitive). */
export function isSameOrUnder(path: string, prefix: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  const q = prefix.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return p === q || p.startsWith(q + "/");
}

/** Re-bases `path` from `from` to `to` (exact match or folder prefix); null if unaffected. */
export function remapPath(path: string, from: string, to: string): string | null {
  const p = path.replace(/\\/g, "/");
  const f = from.replace(/\\/g, "/").replace(/\/+$/, "");
  const t = to.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!isSameOrUnder(p, f)) return null;
  return t + p.slice(f.length);
}

/** Characters not allowed in an entry or folder name. */
const BAD_CHARS = /[\\/:*?"<>|]/;

/** Returns an error message for an invalid name, or null when it's fine. */
export function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter a name";
  if (BAD_CHARS.test(n)) return 'Names can\'t contain \\ / : * ? " < > |';
  if (/^\.+$/.test(n)) return "That name isn't allowed";
  if (n.length > 120) return "That name is too long";
  return null;
}

/** New rel for renaming `rel` to the display name `newName` (keeps ".nqv" for notes). */
export function renamedRel(rel: string, newName: string, dir: boolean): string {
  const n = newName.trim().replace(NQV, "");
  return joinRel(parentRel(rel), dir ? n : `${n}.nqv`);
}

/** New rel for moving `rel` into folder `destFolder` ("" = root). */
export const movedRel = (rel: string, destFolder: string) => joinRel(destFolder, baseName(rel));

/**
 * Whether `rel` can be moved into `destFolder`: not into its current parent,
 * and a folder never into itself or one of its descendants.
 */
export function canMoveTo(rel: string, destFolder: string): boolean {
  const r = normRel(rel);
  const d = normRel(destFolder);
  if (parentRel(r) === d) return false;
  if (d && isSameOrUnder(d, r)) return false;
  return true;
}

/** `base`, `base 2`, `base 3`, … — first one not taken (case-insensitive) among `taken` display names. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set([...taken].map((t) => t.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const c = `${base} ${i}`;
    if (!set.has(c.toLowerCase())) return c;
  }
}

/** Display names of the direct children of `folder` ("" = root). */
export function childNames(items: VaultItem[], folder: string): string[] {
  const f = normRel(folder);
  return items.filter((i) => parentRel(i.rel) === f).map((i) => displayName(i.rel));
}

/** True if an entry with that display name already exists in `folder` (excluding `except`). */
export function nameTaken(items: VaultItem[], folder: string, name: string, except?: string): boolean {
  const n = name.trim().toLowerCase();
  const f = normRel(folder);
  const ex = except ? normRel(except).toLowerCase() : null;
  return items.some((i) => parentRel(i.rel) === f && displayName(i.rel).toLowerCase() === n
    && normRel(i.rel).toLowerCase() !== ex);
}

// ── kinds & tags ─────────────────────────────────────────────────────────────

export function entryKind(item: { dir: boolean; ext: string }): EntryKind {
  if (item.dir) return "folder";
  switch ((item.ext || "").toLowerCase()) {
    case "login": return "login";
    case "ssh": return "ssh";
    case "secret": return "secret";
    case "card": return "card";
    case "wifi": return "wifi";
    case "codes": return "codes";
    default: return "note";
  }
}

/** Trim, drop leading "#", collapse spaces, dedupe case-insensitively, keep order. */
export function normalizeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

/** Every tag used by notes with its count; most used first, then alphabetical. */
export function tagCounts(items: VaultItem[]): { tag: string; count: number }[] {
  const m = new Map<string, { tag: string; count: number }>();
  for (const i of items) {
    if (i.dir) continue;
    for (const t of normalizeTags(i.tags ?? [])) {
      const k = t.toLowerCase();
      const e = m.get(k);
      if (e) e.count++; else m.set(k, { tag: t, count: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || collator.compare(a.tag, b.tag));
}

// ── filtering ────────────────────────────────────────────────────────────────

export interface Filter { query: string; tags: string[] }
export const isFiltering = (f: Filter) => f.query.trim() !== "" || f.tags.length > 0;

/** Does a single note match? (names and tags only — contents are never searched). */
export function matchesFilter(item: VaultItem, f: Filter): boolean {
  const itemTags = (item.tags ?? []).map((t) => t.toLowerCase());
  if (f.tags.length && (item.dir || !f.tags.every((t) => itemTags.includes(t.toLowerCase())))) return false;
  const q = f.query.trim().toLowerCase();
  if (!q) return true;
  return displayName(item.rel).toLowerCase().includes(q) || itemTags.some((t) => t.includes(q));
}

/**
 * Items to show for a filter: matching notes plus their ancestor folders. A
 * folder whose own name matches the query (and no tag filter is active) brings
 * its whole subtree along.
 */
export function filterItems(items: VaultItem[], f: Filter): VaultItem[] {
  if (!isFiltering(f)) return items;
  const keep = new Set<string>();
  const q = f.query.trim().toLowerCase();
  const matchedFolders = !f.tags.length && q
    ? items.filter((i) => i.dir && displayName(i.rel).toLowerCase().includes(q)).map((i) => normRel(i.rel))
    : [];
  for (const i of items) {
    const r = normRel(i.rel);
    const hit = matchedFolders.some((m) => isSameOrUnder(r, m)) || (!i.dir && matchesFilter(i, f));
    if (!hit) continue;
    keep.add(r);
    for (let p = parentRel(r); p; p = parentRel(p)) keep.add(p);
  }
  return items.filter((i) => keep.has(normRel(i.rel)));
}

// ── tree ─────────────────────────────────────────────────────────────────────

function compareNodes(sort: SortMode) {
  return (a: TreeNode, b: TreeNode) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1; // folders first
    if (sort === "modified" && a.updated !== b.updated) return b.updated - a.updated;
    return collator.compare(a.name, b.name);
  };
}

/**
 * Builds a nested tree from the flat list. Folders that only appear as a
 * parent of something (not listed themselves) are created implicitly.
 */
export function buildTree(items: VaultItem[], sort: SortMode = "name"): TreeNode[] {
  const byRel = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  const ensureFolder = (rel: string): TreeNode => {
    const key = rel.toLowerCase();
    let n = byRel.get(key);
    if (n) return n;
    n = { rel, name: displayName(rel), dir: true, kind: "folder", ext: "", updated: 0,
          tags: [], starred: false, depth: rel.split("/").length - 1, children: [] };
    byRel.set(key, n);
    const p = parentRel(rel);
    (p ? ensureFolder(p).children : roots).push(n);
    return n;
  };

  for (const it of items) {
    const rel = normRel(it.rel);
    if (!rel) continue;
    if (it.dir) {
      const f = ensureFolder(rel);
      f.updated = Math.max(f.updated, it.updated || 0);
      f.starred = !!it.starred;
      f.tags = it.tags ?? [];
      continue;
    }
    if (byRel.has(rel.toLowerCase())) continue; // duplicate entry
    const n: TreeNode = {
      rel, name: displayName(rel), dir: false, kind: entryKind(it), ext: it.ext, updated: it.updated || 0,
      tags: normalizeTags(it.tags ?? []), starred: !!it.starred, depth: rel.split("/").length - 1, children: [],
    };
    byRel.set(rel.toLowerCase(), n);
    const p = parentRel(rel);
    (p ? ensureFolder(p).children : roots).push(n);
  }

  const cmp = compareNodes(sort);
  const finish = (nodes: TreeNode[]): number => {
    let newest = 0;
    for (const n of nodes) {
      if (n.dir) n.updated = Math.max(n.updated, finish(n.children));
      newest = Math.max(newest, n.updated);
    }
    nodes.sort(cmp);
    return newest;
  };
  finish(roots);
  return roots;
}

/** Depth-first list of the rows that are currently visible (respecting expansion). */
export function flattenTree(nodes: TreeNode[], isExpanded: (rel: string) => boolean): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (list: TreeNode[], depth: number) => {
    for (const n of list) {
      out.push({ node: n, depth });
      if (n.dir && isExpanded(n.rel)) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out;
}

/** Starred notes and folders (flat), for the pinned "Starred" group. */
export function starredNodes(items: VaultItem[], sort: SortMode = "name"): TreeNode[] {
  const nodes: TreeNode[] = items.filter((i) => i.starred).map((i) => {
    const rel = normRel(i.rel);
    return { rel, name: displayName(rel), dir: i.dir, kind: entryKind(i), ext: i.ext, updated: i.updated || 0,
             tags: normalizeTags(i.tags ?? []), starred: true, depth: 0, children: [] };
  });
  return nodes.sort(compareNodes(sort));
}

/** All folder rels (explicit and implied by notes), sorted — for the "Move to…" picker. */
export function allFolders(items: VaultItem[]): string[] {
  const set = new Map<string, string>();
  for (const i of items) {
    const r = normRel(i.rel);
    if (i.dir) set.set(r.toLowerCase(), r);
    for (let p = parentRel(r); p; p = parentRel(p)) if (!set.has(p.toLowerCase())) set.set(p.toLowerCase(), p);
  }
  return [...set.values()].sort((a, b) => collator.compare(a, b));
}

/** Folder rels that contain `rel` (so revealing it means expanding these). */
export function ancestorsOf(rel: string): string[] {
  const out: string[] = [];
  for (let p = parentRel(rel); p; p = parentRel(p)) out.unshift(p);
  return out;
}

// ── trash ────────────────────────────────────────────────────────────────────

export interface TrashRoot { item: VaultItem; name: string; kind: EntryKind; childCount: number }

/**
 * The Recycle Bin lists a trashed folder's children too; show only the
 * top-most trashed entries (with how many items each folder holds), newest first.
 */
export function trashRoots(trash: VaultItem[]): TrashRoot[] {
  const rels = trash.map((t) => normRel(t.rel));
  const folderRels = trash.filter((t) => t.dir).map((t) => normRel(t.rel));
  const roots: TrashRoot[] = [];
  trash.forEach((item, idx) => {
    const r = rels[idx];
    const insideTrashedFolder = folderRels.some((f) => f !== r && isSameOrUnder(r, f));
    if (insideTrashedFolder) return;
    const childCount = item.dir ? rels.filter((x) => x !== r && isSameOrUnder(x, r)).length : 0;
    roots.push({ item, name: displayName(r), kind: entryKind(item), childCount });
  });
  return roots.sort((a, b) => (b.item.trashed_at ?? 0) - (a.item.trashed_at ?? 0)
    || collator.compare(a.name, b.name));
}

/** Short relative time: "just now", "5 min ago", "3 h ago", "2 d ago", or a date. */
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(ms).toLocaleDateString();
}

/** Days left before the 30-day automatic purge (never negative). */
export function daysUntilPurge(trashedAt: number, now = Date.now(), retentionDays = 30): number {
  const left = retentionDays - (now - trashedAt) / 86_400_000;
  return Math.max(0, Math.ceil(left));
}
