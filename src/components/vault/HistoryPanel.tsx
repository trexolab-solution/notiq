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
export function HistoryPanel({ tab, containerWidth, onClose }: { tab: Tab; containerWidth: number; onClose: () => void }) {
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
                    <div className="text-xs font-medium">{r.index === 0 ? "Previous save" : `${r.index + 1} saves ago`}</div>
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
