import { useCallback, useState } from "react";
import type { SortMode } from "../../../lib/vaultTree";

// Per-device sidebar view state. localStorage may be unavailable — never throw.
const KEY_EXPANDED = "vault:sidebar:expanded";
const KEY_SORT = "vault:sidebar:sort";
const KEY_STARRED_OPEN = "vault:sidebar:starredOpen";

function read<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch { return fallback; }
}
function write(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* unavailable */ }
}

/** Expanded folder rels, remembered across sessions. */
export function useExpanded() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(read<string[]>(KEY_EXPANDED, [])));
  const update = useCallback((fn: (s: Set<string>) => void) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      fn(next);
      write(KEY_EXPANDED, [...next]);
      return next;
    });
  }, []);
  const toggle = useCallback((rel: string, open?: boolean) => update((s) => {
    const want = open ?? !s.has(rel);
    if (want) s.add(rel); else s.delete(rel);
  }), [update]);
  const expandAll = useCallback((rels: string[]) => update((s) => rels.forEach((r) => s.add(r))), [update]);
  /** Keep expansion in sync with a rename/move (`from` → `to`, folder prefixes included). */
  const remap = useCallback((from: string, to: string) => update((s) => {
    for (const r of [...s]) {
      if (r === from || r.startsWith(from + "/")) { s.delete(r); s.add(to + r.slice(from.length)); }
    }
  }), [update]);
  return { expanded, toggle, expandAll, remap };
}

export function useSortMode() {
  const [sort, setSort] = useState<SortMode>(() => (read<string>(KEY_SORT, "name") === "modified" ? "modified" : "name"));
  const set = useCallback((m: SortMode) => { setSort(m); write(KEY_SORT, m); }, []);
  return [sort, set] as const;
}

export function useStarredOpen() {
  const [open, setOpen] = useState<boolean>(() => read<boolean>(KEY_STARRED_OPEN, true));
  const set = useCallback((v: boolean) => { setOpen(v); write(KEY_STARRED_OPEN, v); }, []);
  return [open, set] as const;
}
