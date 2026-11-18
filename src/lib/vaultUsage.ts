import { useSyncExternalStore } from "react";

/**
 * Which entries you open or copy from, and how often: per device, in this browser's storage only (never in the
 * vault, never synced). It feeds the sidebar's "Recently used" / "Most used" sorting.
 */
export interface Usage { last: number; count: number }
export type UsageMap = Readonly<Record<string, Usage>>;

const KEY = "vault:usage";
const MAX = 1000;

const norm = (rel: string) => rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase();

function load(): Record<string, Usage> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Partial<Usage>>;
    const out: Record<string, Usage> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.last === "number" && typeof v.count === "number") out[k] = { last: v.last, count: v.count };
    }
    return out;
  } catch { return {}; }
}

let map: UsageMap = load();
const listeners = new Set<() => void>();

function commit(next: Record<string, Usage>) {
  const keys = Object.keys(next);
  if (keys.length > MAX) {
    keys.sort((a, b) => next[a].last - next[b].last).slice(0, keys.length - MAX).forEach((k) => delete next[k]);
  }
  map = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* unavailable */ }
  listeners.forEach((l) => l());
}

/** Counts one open / copy of the entry at `rel`. */
export function recordUse(rel: string, now = Date.now()) {
  const k = norm(rel);
  if (!k) return;
  const cur = map[k];
  commit({ ...map, [k]: { last: now, count: (cur?.count ?? 0) + 1 } });
}

/** Keeps the history with an entry (or folder) that was renamed or moved. */
export function remapUsage(from: string, to: string) {
  const f = norm(from), t = norm(to);
  if (!f || f === t) return;
  const next: Record<string, Usage> = {};
  let changed = false;
  for (const [k, v] of Object.entries(map)) {
    if (k === f || k.startsWith(f + "/")) { next[t + k.slice(f.length)] = v; changed = true; } else if (!(k in next)) next[k] = v;
  }
  if (changed) commit(next);
}

export function useVaultUsage(): UsageMap {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => map,
  );
}

/** Test helper: forget everything. */
export function resetUsage() { commit({}); }
