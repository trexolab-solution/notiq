import { useEffect, useMemo, useState } from "react";
import { Eye, EyeOff, History, RotateCcw } from "lucide-react";
import { Button } from "../ui/Button";
import { Dialog, DialogBody, DialogText } from "../ui/Dialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useAppStore } from "../../store";
import { useAutoHide } from "../../hooks/useAutoHide";
import { toast } from "../../lib/toast";
import { formatBytes } from "../../lib/vaultBackup";
import { previewRows } from "../../lib/entryPreview";
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

/** Lists earlier saved versions of a vault entry, previews one (secrets masked) and restores it. */
export function HistoryDialog({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const path = tab.filePath!;
  const [revs, setRevs] = useState<VaultRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const [file, setFile] = useState<VaultFile | null>(null);
  const [show, setShow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  useAutoHide(show, setShow);

  useEffect(() => {
    let alive = true;
    vaultHistoryList(path)
      .then((r) => { if (alive) { setRevs(r); if (r.length) setSel(r[0].index); } })
      .catch((e) => { if (alive) setError(vaultErrorMessage(e)); });
    return () => { alive = false; };
  }, [path]);

  useEffect(() => {
    if (sel === null) return;
    let alive = true;
    setFile(null); setShow(false);
    vaultHistoryGet(path, sel)
      .then((f) => { if (alive) setFile(f); })
      .catch((e) => { if (alive) setError(vaultErrorMessage(e)); });
    return () => { alive = false; };
  }, [path, sel]);

  const rows = useMemo(() => (file ? previewRows(file.ext, file.content) : []), [file]);
  const hasSecrets = rows.some((r) => r.secret);

  const restore = async () => {
    if (sel === null) return;
    setConfirm(false); setBusy(true);
    try {
      await vaultHistoryRestore(path, sel);
      await reloadTab(tab.id, path);
      toast.success("Earlier version restored");
      onClose();
    } catch (e) {
      toast.error("Couldn't restore that version", { source: "Vault", detail: vaultErrorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} zClassName="z-[80]" dismissable={!confirm} size="lg"
            title={`History · ${tab.title}`} icon={<History size={16} />}>
      <DialogBody flush fill>
        <div className="dlg-inset flex flex-col gap-2">
          <DialogText>
            Earlier versions are kept encrypted inside the vault — the last {VAULT_MAX_HISTORY} saves of each entry. Restoring keeps the
            current version in this list too.
          </DialogText>
          {error && <p role="alert" className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>

        {revs === null && !error ? (
          <p className="dlg-inset pb-5 text-xs text-[var(--color-text-muted)]">Loading…</p>
        ) : revs && revs.length === 0 ? (
          <p className="dlg-inset pb-5 text-sm text-[var(--color-text-muted)]">
            No earlier versions yet. Each time you save a change to this entry, the previous version is kept here.
          </p>
        ) : revs && (
          <div className="flex min-h-[240px] flex-1 border-t border-[var(--color-border)]">
            <ul className="w-[200px] shrink-0 overflow-y-auto border-r border-[var(--color-border)] py-1" aria-label="Versions">
              {revs.map((r) => (
                <li key={r.index}>
                  <button type="button" onClick={() => setSel(r.index)} aria-current={sel === r.index}
                          className={`w-full text-left px-4 py-1.5 cursor-pointer hover:bg-[var(--color-bg-tertiary)] ${sel === r.index ? "bg-[var(--color-bg-tertiary)]" : ""}`}>
                    <div className="text-xs font-medium">{r.index === 0 ? "Previous save" : `${r.index + 1} saves ago`}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)]">{when(r.updated)} · {formatBytes(r.size)}</div>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
                {!file ? (
                  <p className="text-xs text-[var(--color-text-muted)]">Loading version…</p>
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
              </div>
              <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--color-border)]">
                {hasSecrets && (
                  <Button size="sm" aria-pressed={show} icon={show ? <EyeOff size={13} /> : <Eye size={13} />} onClick={() => setShow((v) => !v)}>
                    {show ? "Hide secrets" : "Show secrets"}
                  </Button>
                )}
                <div className="flex-1" />
                <Button variant="primary" size="sm" icon={<RotateCcw size={13} />} disabled={!file || busy} onClick={() => setConfirm(true)}>
                  {busy ? "Restoring…" : "Restore this version"}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogBody>
      {confirm && sel !== null && (
        <ConfirmDialog
          title="Restore this version?"
          message={`The entry goes back to how it was ${revs?.find((r) => r.index === sel) ? `on ${when(revs.find((r) => r.index === sel)!.updated)}` : "then"}. The current version is kept in History, so you can undo this.`}
          detail={tab.isDirty ? "Unsaved changes in this tab will be lost." : undefined}
          confirmLabel="Restore"
          onConfirm={() => { void restore(); }}
          onCancel={() => setConfirm(false)}
        />
      )}
    </Dialog>
  );
}
