import { useMemo } from "react";
import { ArrowLeft, CheckCheck, CloudDownload } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
import type { VaultItem } from "../../../lib/vault";
import { displayName, entryKind, parentRel } from "../../../lib/vaultTree";
import { markerLabel, reviewList, type SyncMarker } from "../../../lib/syncMarkers";
import { EntryIcon } from "./EntryIcon";

interface Props {
  markers: SyncMarker[];
  items: VaultItem[];
  onBack: () => void;
  /** Open a marked entry (marks it as seen). */
  onOpen: (m: SyncMarker) => void;
  onMarkAllSeen: () => void;
  now?: number;
}

/** "Recently synced": what the last syncs brought in from Drive, newest first, with Mark all as seen. */
export function RecentlySyncedView({ markers, items, onBack, onOpen, onMarkAllSeen, now = Date.now() }: Props) {
  const list = useMemo(() => reviewList(markers), [markers]);
  const byRel = useMemo(() => new Map(items.map((i) => [i.rel.toLowerCase(), i])), [items]);

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <Tooltip content="Back to vault">
          <button type="button" className="vt-icon-btn" onClick={onBack} aria-label="Back to vault">
            <ArrowLeft size={14} />
          </button>
        </Tooltip>
        <h3 className="flex-1 text-xs font-semibold">Recently synced</h3>
        {list.length > 0 && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
            onClick={onMarkAllSeen}
          >
            <CheckCheck size={12} aria-hidden /> Mark all as seen
          </button>
        )}
      </div>

      <div className="vt-scroll" role="list" aria-label="Items changed by sync">
        {list.length === 0 ? (
          <div className="vt-empty">
            <CloudDownload size={22} className="mx-auto mb-2 opacity-50" aria-hidden />
            <div className="vt-empty-title">Nothing new from Drive</div>
            Items another PC adds or changes show up here after a sync, until you open them.
          </div>
        ) : (
          <>
            <p className="px-2 pb-1.5 text-[11px] text-[var(--color-text-muted)]">
              Brought in from Google Drive by sync. Opening an item marks it as seen.
            </p>
            {list.map((m) => {
              const item = byRel.get(m.rel.toLowerCase());
              const kind = entryKind({ dir: m.dir, ext: item?.ext ?? "md" });
              const name = displayName(m.rel);
              const where = parentRel(m.rel);
              const label = markerLabel(m, now);
              const openable = !m.dir && !m.trashed;
              const body = (
                <>
                  <span className="vt-sync-dot" aria-hidden />
                  <EntryIcon kind={kind} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[12.5px]">
                      {name}
                      {where && <span className="text-[11px] text-[var(--color-text-muted)]"> · {displayName(where)}</span>}
                    </div>
                    <div className="vt-trash-meta">{m.trashed ? `${label} · in Trash` : label}</div>
                  </div>
                </>
              );
              return openable ? (
                <button
                  key={m.id}
                  type="button"
                  role="listitem"
                  className="vt-trash-item w-full text-left cursor-pointer border-0 bg-transparent text-[var(--color-text)] focus-visible:outline-2 focus-visible:outline-[var(--color-primary)]"
                  aria-label={`${name}, ${label}. Open`}
                  title={m.rel.replace(/\.nqv$/i, "")}
                  onClick={() => onOpen(m)}
                >
                  {body}
                </button>
              ) : (
                <div key={m.id} role="listitem" className="vt-trash-item" aria-label={`${name}, ${label}`} title={m.rel}>
                  {body}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
