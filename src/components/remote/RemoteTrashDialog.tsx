import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore, File, Folder, Trash2 } from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { RowIconButton } from "../vault/ListEditor";
import { toast } from "../../lib/toast";
import { formatBytes } from "../../lib/vaultBackup";
import {
  formatModified, sftpErrorMessage, sftpTrashDelete, sftpTrashEmpty, sftpTrashList, sftpTrashRestore, SFTP_EXISTS, type TrashItem,
} from "../../lib/sftp";

type Confirm = { kind: "forever"; item: TrashItem } | { kind: "empty" } | null;

/** The server's Trash: what was deleted from the file manager, with Restore, Delete forever and Empty Trash. */
export function RemoteTrashDialog({ session, server, onClose, onChanged }: {
  session: number;
  server: string;
  onClose: () => void;
  /** Something was put back: the folder listing behind the dialog may be stale. */
  onChanged: () => void;
}) {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await sftpTrashList(session)); setError(""); }
    catch (e) { setError(sftpErrorMessage(e)); setItems([]); }
  }, [session]);
  useEffect(() => { void load(); }, [load]);

  const run = async (job: () => Promise<void>, done: string, changed = false) => {
    if (busy) return;
    setBusy(true);
    try { await job(); toast.success(done); if (changed) onChanged(); await load(); }
    catch (e) {
      const m = sftpErrorMessage(e);
      toast.error(m === SFTP_EXISTS ? "Something with that name is already at the original location. Rename or move it first." : m);
    } finally { setBusy(false); }
  };

  const restore = (i: TrashItem) => run(() => sftpTrashRestore(session, i.id), `Restored “${i.id}” to ${i.original}`, true);
  const empty = items?.length ?? 0;

  return (
    <>
      <Dialog title={`Trash · ${server}`} size="lg" onClose={onClose} zClassName="z-[60]">
        <DialogBody>
          {items === null && <p className="text-sm text-[var(--color-text-muted)]" role="status">Loading the Trash…</p>}
          {error && <p className="text-sm text-[var(--color-danger)]" role="alert">{error}</p>}
          {items !== null && !error && items.length === 0 && (
            <p className="py-8 text-center text-sm text-[var(--color-text-muted)]">The Trash is empty. Items you delete from the file manager are kept here until you empty it.</p>
          )}
          {items !== null && items.length > 0 && (
            <ul className="max-h-[50vh] overflow-y-auto divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]" aria-label="Items in the Trash">
              {items.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-3 h-12">
                  <span className={i.kind === "dir" ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"} aria-hidden>
                    {i.kind === "dir" ? <Folder size={16} /> : <File size={16} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm" title={i.id}>{i.id}</p>
                    <p className="truncate text-[11px] text-[var(--color-text-muted)]" title={i.original}>
                      {i.original}{i.deleted ? ` · deleted ${formatModified(i.deleted)}` : ""}{i.kind === "file" ? ` · ${formatBytes(i.size)}` : ""}
                    </p>
                  </div>
                  <RowIconButton label={`Restore ${i.id}`} tooltip="Restore to its original place" icon={<ArchiveRestore size={15} />} disabled={busy} onClick={() => void restore(i)} />
                  <RowIconButton label={`Delete ${i.id} forever`} tooltip="Delete forever" icon={<Trash2 size={15} />} danger disabled={busy} onClick={() => setConfirm({ kind: "forever", item: i })} />
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <DialogButton variant="danger" icon={<Trash2 size={13} />} disabled={empty === 0 || busy} onClick={() => setConfirm({ kind: "empty" })}>Empty Trash</DialogButton>
          <DialogButton cancel onClick={onClose}>Close</DialogButton>
        </DialogFooter>
      </Dialog>

      {confirm?.kind === "forever" && (
        <ConfirmDialog title={`Delete “${confirm.item.id}” forever?`}
                       message={`It will be permanently deleted from ${server}${confirm.item.kind === "dir" ? ", together with everything inside it" : ""}. This can't be undone.`}
                       icon="danger" danger confirmLabel="Delete forever" zClassName="z-[70]"
                       onConfirm={() => { const i = confirm.item; setConfirm(null); void run(() => sftpTrashDelete(session, i.id), `Deleted “${i.id}” forever`); }}
                       onCancel={() => setConfirm(null)} />
      )}
      {confirm?.kind === "empty" && (
        <ConfirmDialog title="Empty the Trash?" message={`All ${empty} item${empty === 1 ? "" : "s"} in the Trash will be permanently deleted from ${server}. This can't be undone.`}
                       icon="danger" danger confirmLabel="Empty Trash" zClassName="z-[70]"
                       onConfirm={() => { setConfirm(null); void run(() => sftpTrashEmpty(session), "The Trash is empty"); }}
                       onCancel={() => setConfirm(null)} />
      )}
    </>
  );
}
