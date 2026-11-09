import { useEffect, useMemo } from "react";
import { CloudDownload } from "lucide-react";
import { markerLabel, relOfPath, useSyncMarkersStore, type SyncMarker } from "../../lib/syncMarkers";

/** What "Show changes" asks the History panel for: compare the pre-sync version with the current one. */
export interface CompareRequest {
  markerId: string;
  /** History index of the pre-sync version, when it is in history (the list marks it). */
  beforeIndex: number | null;
  /** "Updated from Drive · from LAPTOP · 2 hours ago" */
  label: string;
}

/** Banner text: "Added from Drive" for a new entry (nothing to compare with), else the marker label. */
export function bannerText(m: SyncMarker, now = Date.now()): string {
  const label = markerLabel(m, now);
  return m.kind === "added" ? label.replace(/^New from Drive/, "Added from Drive") : label;
}

/**
 * Slim banner under an entry's sticky header when a sync brought this entry in from Drive:
 * "Updated from Drive · from LAPTOP · 2 hours ago · Show changes · Dismiss". Opening the entry marks it as
 * seen (the sidebar dot goes); the banner stays until dismissed or the tab is closed.
 */
export function SyncChangeBanner({ path, onShowChanges }: { path: string | undefined; onShowChanges?: (c: CompareRequest) => void }) {
  const markers = useSyncMarkersStore((s) => s.markers);
  const opened = useSyncMarkersStore((s) => s.opened);
  const loaded = useSyncMarkersStore((s) => s.loaded);
  useEffect(() => { if (!loaded) void useSyncMarkersStore.getState().refresh(); }, [loaded]);

  const rel = useMemo(
    () => (path ? relOfPath([...Object.keys(opened), ...markers.map((m) => m.rel)], path) : null),
    [markers, opened, path],
  );
  const marker = rel ? opened[rel] ?? markers.find((m) => m.rel.toLowerCase() === rel) : undefined;
  const isOpened = !!rel && rel in opened;

  // Seen now: the sidebar dot goes; this banner keeps its copy.
  useEffect(() => {
    if (rel && marker && !isOpened) useSyncMarkersStore.getState().markOpened(rel);
  }, [rel, marker, isOpened]);

  if (!rel || !marker || marker.deleted) return null;
  const text = bannerText(marker);
  const canCompare = marker.kind !== "added" && marker.hasBefore && !!onShowChanges;

  return (
    <div
      role="status"
      data-sync-banner={marker.kind}
      className="-mx-6 px-6 mt-2 py-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--color-text-muted)] border-b border-[var(--color-border)]"
      style={{ background: "color-mix(in srgb, var(--color-primary) 8%, transparent)" }}
    >
      <CloudDownload size={13} className="shrink-0 text-[var(--color-primary)]" aria-hidden />
      <span className="min-w-0 text-[var(--color-text)]">{text}</span>
      {canCompare && (
        <>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="cursor-pointer text-[var(--color-primary)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] rounded"
            onClick={() => onShowChanges!({ markerId: marker.id, beforeIndex: marker.beforeIndex, label: text })}
          >
            Show changes
          </button>
        </>
      )}
      <span aria-hidden>·</span>
      <button
        type="button"
        className="cursor-pointer hover:text-[var(--color-text)] hover:underline focus-visible:outline-2 focus-visible:outline-[var(--color-primary)] rounded"
        aria-label="Dismiss sync notice"
        onClick={() => useSyncMarkersStore.getState().dismissBanner(rel)}
      >
        Dismiss
      </button>
    </div>
  );
}
