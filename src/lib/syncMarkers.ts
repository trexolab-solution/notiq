import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { relativeTime, SYNC_CHANGED_EVENT, type SyncResult } from "./vaultSync";
import type { ToastAction } from "./toast";
import type { VaultFile } from "./vault";

/**
 * "Changed by sync" markers: entries a Vault Sync merge brought in from Google Drive (added, updated,
 * restored, removed), kept on this device only (sealed with the vault key, never synced). The sidebar
 * shows a dot on them, the entry form a banner with "Show changes"; opening an entry marks it as seen.
 */

export type SyncChangeKind = "added" | "updated" | "restored" | "removed";

export interface SyncMarker {
  /** Entry id. */
  id: string;
  kind: SyncChangeKind;
  /** Device NAME the change came from ("" when unknown). */
  fromDevice: string;
  /** Unix ms of the sync. */
  at: number;
  /** The entry's vault-relative path now. */
  rel: string;
  dir: boolean;
  trashed: boolean;
  deleted: boolean;
  /** A "before" version can be compared with. */
  hasBefore: boolean;
  /** History index holding the "before" version (null when only the marker keeps a copy). */
  beforeIndex: number | null;
}

export const SYNC_MARKERS_EVENT = "vault-sync://markers";

export const syncMarkersList = () => invoke<SyncMarker[]>("sync_markers_list");
export const syncMarkerBefore = (id: string) => invoke<VaultFile | null>("sync_marker_before", { id });
export const syncMarkerClear = (id: string) => invoke<void>("sync_marker_clear", { id });
export const syncMarkersClearAll = () => invoke<void>("sync_markers_clear_all");

// ── Presentation (pure) ───────────────────────────────────────────────────────

const TITLES: Record<SyncChangeKind, string> = {
  added: "New from Drive",
  updated: "Updated from Drive",
  restored: "Restored from Drive",
  removed: "Removed by sync",
};

/** "Updated from Drive", "New from Drive", … */
export const markerTitle = (m: Pick<SyncMarker, "kind">) => TITLES[m.kind];

/** "Updated from Drive · from LAPTOP · 2 hours ago" (the device part only when known). */
export function markerLabel(m: Pick<SyncMarker, "kind" | "fromDevice" | "at">, now = Date.now()): string {
  const dev = m.fromDevice.trim();
  return [markerTitle(m), dev ? `from ${dev}` : "", relativeTime(m.at, now)].filter(Boolean).join(" · ");
}

/** Markers by lower-cased rel, for the tree (entries that can't be shown are left out). */
export function markerIndex(markers: SyncMarker[]): Map<string, SyncMarker> {
  const m = new Map<string, SyncMarker>();
  for (const x of markers) if (!x.deleted && !x.trashed) m.set(x.rel.toLowerCase(), x);
  return m;
}

/** How many marked entries are inside folder `rel` (at any depth). */
export function markedInside(index: Map<string, SyncMarker>, rel: string): number {
  const prefix = `${rel.toLowerCase()}/`;
  let n = 0;
  for (const k of index.keys()) if (k.startsWith(prefix)) n++;
  return n;
}

/**
 * The (lower-cased) rel among `rels` that full path `path` ends with — the longest, so "Work/a.nqv" wins
 * over "a.nqv" for ".../vault/Work/a.nqv". null when none does.
 */
export function relOfPath(rels: Iterable<string>, path: string): string | null {
  const p = path.replace(/\\/g, "/").toLowerCase();
  let best: string | null = null;
  for (const r of rels) {
    const k = r.toLowerCase();
    if (p.endsWith(`/${k}`) && (!best || k.length > best.length)) best = k;
  }
  return best;
}

/** Visible markers (not on deleted entries), newest first. */
export const reviewList = (markers: SyncMarker[]) =>
  markers.filter((m) => !m.deleted).sort((a, b) => b.at - a.at);

// ── Store ─────────────────────────────────────────────────────────────────────

interface MarkersStore {
  markers: SyncMarker[];
  /** The first list has arrived (or failed). */
  loaded: boolean;
  /** Markers cleared by opening their entry this session, by lower-cased rel: the entry banner keeps them. */
  opened: Record<string, SyncMarker>;
  /** The sidebar shows the "Recently synced" view. */
  reviewOpen: boolean;
  /** Bumped by "Review": the sidebar opens the vault panel. */
  reviewRequest: number;
  refresh: () => Promise<void>;
  /** The user opened the entry at `rel`: its marker is cleared (kept for its banner this session). */
  markOpened: (rel: string) => void;
  /** Hides the banner of `rel`. */
  dismissBanner: (rel: string) => void;
  clearAll: () => Promise<void>;
  setReviewOpen: (open: boolean) => void;
  openReview: () => void;
}

let refreshSeq = 0;

export const useSyncMarkersStore = create<MarkersStore>((set, get) => ({
  markers: [],
  loaded: false,
  opened: {},
  reviewOpen: false,
  reviewRequest: 0,
  async refresh() {
    const my = ++refreshSeq;
    try {
      const markers = await syncMarkersList();
      if (my === refreshSeq) set({ markers: Array.isArray(markers) ? markers : [], loaded: true });
    } catch {
      if (my === refreshSeq) set({ markers: [], loaded: true }); // locked or no vault: nothing to show
    }
  },
  markOpened(rel) {
    const key = rel.toLowerCase();
    const m = get().markers.find((x) => x.rel.toLowerCase() === key);
    if (!m) return;
    set((s) => ({ markers: s.markers.filter((x) => x.id !== m.id), opened: { ...s.opened, [key]: m } }));
    syncMarkerClear(m.id).catch(() => { /* best effort: the dot comes back on the next refresh */ });
  },
  dismissBanner(rel) {
    const key = rel.toLowerCase();
    set((s) => {
      if (!(key in s.opened)) return s;
      const opened = { ...s.opened };
      delete opened[key];
      return { opened };
    });
  },
  async clearAll() {
    set({ markers: [] });
    try { await syncMarkersClearAll(); } finally { void get().refresh(); }
  },
  setReviewOpen(open) { set({ reviewOpen: open }); },
  openReview() { set((s) => ({ reviewOpen: true, reviewRequest: s.reviewRequest + 1 })); },
}));

/** Follows marker changes (and syncs, which can rename entries). Returns the unsubscribe. */
export function followSyncMarkers(): () => void {
  const uns: UnlistenFn[] = [];
  let done = false;
  const refresh = () => void useSyncMarkersStore.getState().refresh();
  for (const ev of [SYNC_MARKERS_EVENT, SYNC_CHANGED_EVENT]) {
    listen(ev, refresh)
      .then((u) => { if (done) u(); else uns.push(u); })
      .catch(() => { /* events unavailable (tests, browser preview) */ });
  }
  refresh();
  return () => { done = true; uns.forEach((u) => u()); };
}

/** The "Review" action for a sync result toast that brought changes (none when nothing changed). */
export function reviewActions(r: SyncResult | null | undefined): ToastAction[] {
  if (!r || r.added + r.updated + r.removed === 0) return [];
  return [{ label: "Review", onClick: () => useSyncMarkersStore.getState().openReview() }];
}
