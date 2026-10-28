import { useMemo, useState } from "react";
import { ArrowLeft, ArchiveRestore, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import type { VaultItem } from "../../../lib/vault";
import { daysUntilPurge, relativeTime, trashRoots, type TrashRoot } from "../../../lib/vaultTree";
import { EntryIcon } from "./EntryIcon";

interface Props {
  trash: VaultItem[];
  onBack: () => void;
  onRestore: (rel: string) => Promise<void>;
  onPurge: (rel: string) => Promise<void>;
  onEmpty: () => Promise<void>;
}

type Confirm = { kind: "purge"; root: TrashRoot } | { kind: "empty" } | null;

/** Recycle Bin: trashed entries with Restore / Delete forever, plus Empty trash. */
export function TrashView({ trash, onBack, onRestore, onPurge, onEmpty }: Props) {
  const roots = useMemo(() => trashRoots(trash), [trash]);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try { await fn(); } finally { setBusy(null); }
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <button type="button" className="vt-icon-btn" onClick={onBack} aria-label="Back to vault" title="Back to vault">
          <ArrowLeft size={14} />
        </button>
        <span className="flex-1 text-xs font-semibold">Trash</span>
        {roots.length > 0 && (
          <button
            type="button"
            className="text-[11px] px-2 py-1 rounded cursor-pointer text-[var(--color-danger)] hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-2 focus-visible:outline-[var(--color-danger)]"
            onClick={() => setConfirm({ kind: "empty" })}
          >
            Empty trash
          </button>
        )}
      </div>

      <div className="vt-scroll" role="list" aria-label="Trashed items">
        {roots.length === 0 ? (
          <div className="vt-empty">
            <Trash2 size={22} className="mx-auto mb-2 opacity-50" aria-hidden />
            <div className="vt-empty-title">Trash is empty</div>
            Deleted secrets stay here for 30 days, then they're removed for good automatically.
          </div>
        ) : (
          <>
            <p className="px-2 pb-1.5 text-[11px] text-[var(--color-text-muted)]">
              Items are deleted for good 30 days after they were trashed.
            </p>
            {roots.map((r) => {
              const key = r.item.rel;
              const at = r.item.trashed_at ?? 0;
              const left = daysUntilPurge(at);
              return (
                <div key={key} className="vt-trash-item" role="listitem" title={r.item.rel.replace(/\.nqv$/i, "")}>
                  <EntryIcon kind={r.kind} />
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[12.5px]">{r.name}</div>
                    <div className="vt-trash-meta">
                      {at ? `Deleted ${relativeTime(at)}` : "Deleted"}
                      {r.childCount > 0 && ` · ${r.childCount} item${r.childCount === 1 ? "" : "s"}`}
                      {at ? ` · ${left === 0 ? "removing soon" : `${left} d left`}` : ""}
                    </div>
                  </div>
                  <button
                    type="button" className="vt-icon-btn" disabled={busy === key}
                    aria-label={`Restore ${r.name}`} title="Restore"
                    onClick={() => void run(key, () => onRestore(key))}
                  >
                    <ArchiveRestore size={14} />
                  </button>
                  <button
                    type="button" className="vt-icon-btn" disabled={busy === key}
                    aria-label={`Delete ${r.name} forever`} title="Delete forever"
                    onClick={() => setConfirm({ kind: "purge", root: r })}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>

      {confirm?.kind === "purge" && (
        <ConfirmDialog
          title="Delete forever?"
          message={`“${confirm.root.name}”${confirm.root.childCount ? ` and the ${confirm.root.childCount} items inside it` : ""} will be permanently deleted. This can't be undone.`}
          confirmLabel="Delete forever"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const rel = confirm.root.item.rel;
            setConfirm(null);
            void run(rel, () => onPurge(rel));
          }}
        />
      )}
      {confirm?.kind === "empty" && (
        <ConfirmDialog
          title="Empty trash?"
          message={`All ${roots.length} item${roots.length === 1 ? "" : "s"} in the trash will be permanently deleted. This can't be undone.`}
          confirmLabel="Empty trash"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { setConfirm(null); void run("*", onEmpty); }}
        />
      )}
    </div>
  );
}
