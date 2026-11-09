import { useEffect, useMemo, useRef, useState } from "react";
import { Eye, EyeOff, History, RotateCcw, X } from "lucide-react";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { InlineLoading } from "../ui/Loading";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useAppStore } from "../../store";
import { useAutoHide } from "../../hooks/useAutoHide";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { usePanelResize } from "../../hooks/usePanelResize";
import { toast } from "../../lib/toast";
import { formatBytes } from "../../lib/vaultBackup";
import { previewRows } from "../../lib/entryPreview";
import { historyPanelOverlays, historyPanelWidth } from "../../lib/historyPanelWidth";
import {
  vaultErrorMessage, vaultHistoryGet, vaultHistoryList, vaultHistoryRestore, vaultReadFile, VAULT_MAX_HISTORY,
  type VaultFile, type VaultRevision,
} from "../../lib/vault";
import type { Tab } from "../../types";
import { diffEntries, type FieldDiff } from "../../lib/entryDiff";
import { syncMarkerBefore } from "../../lib/syncMarkers";
import type { CompareRequest } from "./SyncChangeBanner";

const when = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Re-reads the entry after a restore and shows it in the tab (clean: it matches what's stored). */
async function reloadTab(tabId: string, path: string) {
  const file = await vaultReadFile(path);
  useAppStore.setState((s) => ({
    tabs: s.tabs.map((t) => (t.id === tabId
      ? { ...t, content: file.content, vaultExt: file.ext || "md", isDirty: false, updatedAt: Date.now() }
      : t)),
  }));
}

/**
 * Right-hand side panel of a vault entry tab: earlier saved versions, a preview of one (secrets masked)
 * and restore. Resizable by its left edge; overlays the form when the tab is too narrow for both.
 */
export function HistoryPanel({ tab, containerWidth, onClose, compare = null, onExitCompare }: {
  tab: Tab; containerWidth: number; onClose: () => void;
  /** Compare mode: the version a sync replaced against the current one (shown above the versions). */
  compare?: CompareRequest | null;
  onExitCompare?: () => void;
}) {
  const path = tab.filePath!;
  const [revs, setRevs] = useState<VaultRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [file, setFile] = useState<VaultFile | null>(null);
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Bumped after a restore or save: the list and the selected version's content have changed. */
  const [reload, setReload] = useState(0);
  const panelRef = useRef<HTMLElement>(null);
  useAutoHide(show, setShow);

  const overlay = historyPanelOverlays(containerWidth);
  const { width, dragging, handleProps } = usePanelResize(historyPanelWidth, {
    edge: "left", available: containerWidth, label: "Resize history panel",
  });

  useEscapeKey((e) => {
    if (confirm || e.defaultPrevented || !panelRef.current?.contains(document.activeElement)) return;
    e.preventDefault();
    onClose();
  });

  // A save from the tab (dirty → clean) adds a version: refresh.
  const wasDirty = useRef(tab.isDirty);
  useEffect(() => {
    if (wasDirty.current && !tab.isDirty) setReload((n) => n + 1);
    wasDirty.current = tab.isDirty;
  }, [tab.isDirty]);

  useEffect(() => {
    let alive = true;
    vaultHistoryList(path)
      .then((r) => { if (alive) { setError(null); setRevs(r); setSel(r.length ? r[0].index : null); } })
      .catch((e) => { if (alive) setError(vaultErrorMessage(e)); });
    return () => { alive = false; };
  }, [path, reload]);

  useEffect(() => {
    if (sel === null) return;
    let alive = true;
    setFile(null); setShow(false);
    vaultHistoryGet(path, sel)
      .then((f) => { if (alive) setFile(f); })
      .catch((e) => { if (alive) setError(vaultErrorMessage(e)); });
    return () => { alive = false; };
  }, [path, sel, reload]);

  const rows = useMemo(() => (file ? previewRows(file.ext, file.content) : []), [file]);
  const hasSecrets = rows.some((r) => r.secret);
  const selRev = revs?.find((r) => r.index === sel);

  const restore = async () => {
    if (sel === null) return;
    setConfirm(false); setBusy(true);
    try {
      await vaultHistoryRestore(path, sel);
      await reloadTab(tab.id, path);
      toast.success("Earlier version restored");
      setReload((n) => n + 1);
    } catch (e) {
      toast.error("Couldn't restore that version", { source: "Vault", detail: vaultErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      ref={panelRef}
      role="complementary"
      aria-label={`History of ${tab.title}`}
      style={{ width, maxWidth: "100%" }}
      className={`flex flex-col min-h-0 border-l border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] ${
        overlay ? "absolute inset-y-0 right-0 z-10 shadow-xl" : "relative shrink-0"}`}
    >
      <div className={`vt-resize-handle vt-resize-handle--left${dragging ? " is-dragging" : ""}`} {...handleProps} />

      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border)]">
        <History size={14} aria-hidden style={{ color: "var(--color-primary)" }} />
        <h2 className="flex-1 min-w-0 truncate text-sm font-semibold">History</h2>
        <Tooltip content="Close history (Esc)">
          <Button size="sm" aria-label="Close history" icon={<X size={14} />} onClick={onClose} />
        </Tooltip>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {compare && <SyncCompare path={path} req={compare} reload={reload} onExit={onExitCompare} />}
        <div className="px-3 py-2 flex flex-col gap-2">
          <p className="text-xs text-[var(--color-text-muted)]">
            Earlier versions are kept encrypted inside the vault — the last {VAULT_MAX_HISTORY} saves of each entry.
            Restoring keeps the current version in this list too.
          </p>
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>

        {revs === null && !error ? (
          <InlineLoading label="Loading versions…" className="px-3 pb-4" reserveSpace />
        ) : revs && revs.length === 0 ? (
          <p className="px-3 pb-4 text-sm text-[var(--color-text-muted)]">
            No earlier versions yet. Each time you save a change to this entry, the previous version is kept here.
          </p>
        ) : revs && (
          <>
            <ul className="border-y border-[var(--color-border)] py-1" aria-label="Versions">
              {revs.map((r) => (
                <li key={r.index}>
                  <button type="button" onClick={() => setSel(r.index)} aria-current={sel === r.index}
                          className={`w-full text-left px-3 py-1.5 cursor-pointer hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-primary)]/50 ${sel === r.index ? "bg-[var(--color-bg-tertiary)]" : ""}`}>
                    <div className="text-xs font-medium flex items-center gap-1.5">
                      {r.index === 0 ? "Previous save" : `${r.index + 1} saves ago`}
                      {compare && compare.beforeIndex === r.index && (
                        <span className="text-[10px] px-1 rounded border border-[var(--color-primary)] text-[var(--color-primary)]">Before sync</span>
                      )}
                    </div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{when(r.updated)} · {formatBytes(r.size)}</div>
                  </button>
                </li>
              ))}
            </ul>
            <section aria-label="Version preview" className="px-3 py-3">
              {!file ? (
                <InlineLoading label="Loading version…" />
              ) : rows.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)]">This version was empty.</p>
              ) : (
                <dl className="flex flex-col gap-2">
                  {rows.map((r, i) => (
                    <div key={i}>
                      <dt className="text-[11px] text-[var(--color-text-muted)]">{r.label}</dt>
                      <dd className={`text-sm whitespace-pre-wrap break-words ${r.secret ? "font-mono" : ""}`}>
                        {r.secret && !show ? "••••••••" : r.value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
          </>
        )}
      </div>

      {revs && revs.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-t border-[var(--color-border)]">
          {hasSecrets && (
            <Button size="sm" aria-pressed={show} icon={show ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((v) => !v)}>
              {show ? "Hide secrets" : "Show secrets"}
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="primary" size="sm" icon={<RotateCcw size={13} />} disabled={!file} loading={busy} loadingText="Restoring…" onClick={() => setConfirm(true)}>
            Restore this version
          </Button>
        </div>
      )}

      {confirm && sel !== null && (
        <ConfirmDialog
          title="Restore this version?"
          message={`The entry goes back to how it was ${selRev ? `on ${when(selRev.updated)}` : "then"}. The current version is kept in History, so you can undo this.`}
          detail={tab.isDirty ? "Unsaved changes in this tab will be lost." : undefined}
          confirmLabel="Restore"
          onConfirm={() => { void restore(); }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </aside>
  );
}

const DIFF_BG: Record<"before" | "after", string> = {
  before: "color-mix(in srgb, var(--color-danger) 12%, transparent)",
  after: "color-mix(in srgb, var(--color-success) 12%, transparent)",
};

/** One side of a changed field; secrets masked until shown. */
function DiffValue({ side, value, secret, show }: { side: "before" | "after"; value: string | null; secret: boolean; show: boolean }) {
  const label = side === "before" ? "Before" : "Now";
  return (
    <div className="flex gap-2 rounded px-1.5 py-1" style={{ background: value === null ? undefined : DIFF_BG[side] }}>
      <span className="w-10 shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-text-muted)] pt-0.5">{label}</span>
      <span className={`min-w-0 flex-1 text-sm whitespace-pre-wrap break-words ${secret ? "font-mono" : ""} ${
        value === null ? "italic text-[var(--color-text-muted)]" : side === "before" ? "line-through decoration-1 opacity-80" : ""}`}>
        {value === null ? (side === "before" ? "(not set)" : "(removed)") : secret && !show ? "••••••••" : value}
      </span>
    </div>
  );
}

/**
 * "Changes from Drive": field-level comparison of the version a sync replaced (kept in history, or by the
 * sync marker) with the entry as it is stored now. Changed fields first; secrets masked with a reveal.
 */
function SyncCompare({ path, req, reload, onExit }: { path: string; req: CompareRequest; reload: number; onExit?: () => void }) {
  const [diff, setDiff] = useState<FieldDiff[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useAutoHide(show, setShow);

  useEffect(() => {
    let alive = true;
    setDiff(null); setMissing(false); setError(null);
    Promise.all([syncMarkerBefore(req.markerId), vaultReadFile(path)])
      .then(([before, now]) => {
        if (!alive) return;
        if (!before) { setMissing(true); return; }
        setDiff(diffEntries(before, now));
      })
      .catch((e) => { if (alive) setError(vaultErrorMessage(e)); });
    return () => { alive = false; };
  }, [path, req.markerId, reload]);

  const changed = diff?.filter((d) => d.status !== "same") ?? [];
  const same = (diff?.length ?? 0) - changed.length;
  const hasSecrets = changed.some((d) => d.secret);

  return (
    <section aria-label="Changes from Drive" className="px-3 py-2 border-b border-[var(--color-border)]"
             style={{ background: "color-mix(in srgb, var(--color-primary) 6%, transparent)" }}>
      <div className="flex items-center gap-2">
        <h3 className="flex-1 min-w-0 text-xs font-semibold">Changes from Drive</h3>
        {hasSecrets && (
          <Button size="sm" aria-pressed={show} icon={show ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((v) => !v)}>
            {show ? "Hide" : "Reveal"}
          </Button>
        )}
        {onExit && (
          <Tooltip content="Back to the version list">
            <Button size="sm" aria-label="Close comparison" icon={<X size={13} />} onClick={onExit} />
          </Tooltip>
        )}
      </div>
      <p className="text-[11px] text-[var(--color-text-muted)] mb-2">{req.label}. Before the sync → now.</p>
      {error ? (
        <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>
      ) : missing ? (
        <p className="text-xs text-[var(--color-text-muted)]">The version from before the sync is no longer available.</p>
      ) : !diff ? (
        <InlineLoading label="Comparing…" />
      ) : (
        <>
          <p role="status" className="text-xs mb-2">
            {changed.length === 0 ? "No field changed (only the name, tags or attachments did)."
              : `${changed.length} field${changed.length === 1 ? "" : "s"} changed${same ? `, ${same} unchanged` : ""}.`}
          </p>
          <dl className="flex flex-col gap-2" data-testid="sync-diff">
            {changed.map((d, i) => (
              <div key={`${d.label}-${i}`} data-diff={d.status}>
                <dt className="text-[11px] font-medium text-[var(--color-text-muted)] mb-0.5">
                  {d.label}{d.status === "added" ? " · new" : d.status === "removed" ? " · removed" : ""}
                </dt>
                <dd className="flex flex-col gap-0.5">
                  <DiffValue side="before" value={d.before} secret={d.secret} show={show} />
                  <DiffValue side="after" value={d.after} secret={d.secret} show={show} />
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
