import { useCallback, useEffect, useState } from "react";
import { Download, File, Paperclip, Plus, Trash2 } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { Button } from "../ui/Button";
import { Tooltip } from "../ui/Tooltip";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { CollapsibleSection } from "./EntryParts";
import { useAppStore } from "../../store";
import { toast } from "../../lib/toast";
import { formatBytes } from "../../lib/vaultBackup";
import { resolveVaultDir } from "../../lib/vaultDir";
import { attachmentLimitError, fileNameOf, vaultAttachmentsUsed } from "../../lib/attachmentLimits";
import {
  bytesToBase64, isVaultPath, vaultAttachAdd, vaultAttachExport, vaultAttachList, vaultAttachRemove, vaultErrorMessage,
  VAULT_ATTACH_MAX_PER_NOTE, VAULT_ATTACH_MAX_TOTAL, type VaultAttachment,
} from "../../lib/vault";
import type { Tab } from "../../types";

const EXPORT_WARNED_KEY = "notiq.vault.attachExportWarned";
const wasWarned = () => { try { return localStorage.getItem(EXPORT_WARNED_KEY) === "1"; } catch { return false; } };
const markWarned = () => { try { localStorage.setItem(EXPORT_WARNED_KEY, "1"); } catch { /* private storage */ } };

/** Saves the tab first when it has unsaved edits (attachments act on the stored entry). */
async function ensureSaved(tabId: string): Promise<string | null> {
  const st = useAppStore.getState();
  const cur = st.tabs.find((t) => t.id === tabId);
  if (!cur || !isVaultPath(cur.filePath)) return null;
  if (cur.isDirty && !(await st.saveTabToFile(tabId))) return null;
  return cur.filePath!;
}

/** Collapsible "Attachments (n)" section for a structured vault entry. Files are stored encrypted in the vault. */
export function AttachmentsPanel({ tab }: { tab: Tab }) {
  const path = tab.filePath;
  const [open_, setOpen] = useState(false);
  const [list, setList] = useState<VaultAttachment[] | null>(null);
  const [vaultUsed, setVaultUsed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<VaultAttachment | null>(null);
  const [exportWarn, setExportWarn] = useState<VaultAttachment | null>(null);

  const reload = useCallback(async () => {
    if (!path || !isVaultPath(path)) { setList([]); return; }
    try { setList(await vaultAttachList(path)); } catch { setList([]); }
  }, [path]);

  const reloadUsed = useCallback(async () => {
    try { setVaultUsed(await vaultAttachmentsUsed(await resolveVaultDir())); } catch { setVaultUsed(null); }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => { if (open_) void reloadUsed(); }, [open_, reloadUsed]);

  const add = async () => {
    if (busy) return;
    const picked = await open({ multiple: true, directory: false, title: "Attach files" });
    const files = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    if (files.length === 0) return;
    setBusy(true);
    try {
      const target = await ensureSaved(tab.id);
      if (!target) { toast.error("Save this entry first, then add attachments"); return; }
      let count = (await vaultAttachList(target)).length;
      let used = await vaultAttachmentsUsed(await resolveVaultDir());
      let added = 0;
      for (const file of files) {
        const name = fileNameOf(file);
        const size = (await stat(file)).size;
        const why = attachmentLimitError(size, count, used);
        if (why) { toast.error(`${name}: ${why}`); continue; }
        try {
          // Bytes live only in this scope: read → encode → send, then they're garbage.
          const b64 = bytesToBase64(await readFile(file));
          await vaultAttachAdd(target, name, b64);
          count++; used += size; added++;
        } catch (e) {
          toast.error(`${name}: ${vaultErrorMessage(e)}`);
        }
      }
      if (added) toast.success(added === 1 ? "Attachment added" : `${added} attachments added`);
      setVaultUsed(used);
    } catch (e) {
      toast.error(vaultErrorMessage(e));
    } finally {
      setBusy(false);
      void reload();
    }
  };

  const doExport = async (a: VaultAttachment) => {
    if (!path) return;
    try {
      const dest = await save({ defaultPath: a.name, title: `Save "${a.name}"` });
      if (!dest) return;
      // The OS save dialog already asked about replacing an existing file.
      await vaultAttachExport(path, a.id, dest, true);
      toast.success(`Saved ${a.name}`);
    } catch (e) {
      toast.error(`Couldn't save the file: ${vaultErrorMessage(e)}`);
    }
  };

  const requestExport = (a: VaultAttachment) => {
    if (wasWarned()) void doExport(a);
    else setExportWarn(a);
  };

  const doRemove = async (a: VaultAttachment) => {
    setRemoving(null);
    if (!path) return;
    try {
      await vaultAttachRemove(path, a.id);
      toast.info(`Removed ${a.name}`);
      setVaultUsed((u) => (u === null ? u : Math.max(0, u - a.size)));
    } catch (e) {
      toast.error(vaultErrorMessage(e));
    } finally {
      void reload();
    }
  };

  const n = list?.length ?? 0;
  const entryBytes = (list ?? []).reduce((s, a) => s + a.size, 0);
  const full = n >= VAULT_ATTACH_MAX_PER_NOTE;

  return (
    <CollapsibleSection id={`att-${tab.id}`} title={`Attachments (${n})`} summary={n ? formatBytes(entryBytes) : "Files kept encrypted with this entry"}
                        open={open_} onToggle={() => setOpen((v) => !v)}>
      {n === 0 ? (
        <p className="text-xs text-[var(--color-text-muted)]">
          No files yet. Attach a scan, key file or document (up to 5 MB each); it's stored encrypted inside the vault.
        </p>
      ) : (
        <ul className="flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {list!.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-2.5 py-1.5">
              <File size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate" title={a.name}>{a.name}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">
                  {formatBytes(a.size)} · added {new Date(a.added).toLocaleDateString()}
                </div>
              </div>
              <Tooltip content="Save a copy to disk">
                <Button size="sm" aria-label={`Save ${a.name}`} icon={<Download size={13} />} onClick={() => requestExport(a)} />
              </Tooltip>
              <Tooltip content="Remove attachment">
                <Button size="sm" variant="danger" aria-label={`Remove ${a.name}`} icon={<Trash2 size={13} />} onClick={() => setRemoving(a)} />
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" icon={busy ? <Paperclip size={12} /> : <Plus size={12} />} disabled={busy || full || !path}
                title={full ? `At most ${VAULT_ATTACH_MAX_PER_NOTE} attachments per entry` : undefined}
                onClick={() => { void add(); }}>
          {busy ? "Adding…" : "Add files…"}
        </Button>
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {n}/{VAULT_ATTACH_MAX_PER_NOTE} files
          {vaultUsed !== null && ` · ${formatBytes(vaultUsed)} of ${formatBytes(VAULT_ATTACH_MAX_TOTAL)} used in the vault`}
        </span>
      </div>

      {removing && (
        <ConfirmDialog
          title="Remove attachment?"
          message={`"${removing.name}" will be deleted from the vault. This can't be undone.`}
          confirmLabel="Remove"
          danger
          onConfirm={() => { void doRemove(removing); }}
          onCancel={() => setRemoving(null)}
        />
      )}
      {exportWarn && (
        <ConfirmDialog
          title="Saved files aren't encrypted"
          message="The copy you save to disk is a normal, unencrypted file that anyone with access to this computer can open. Delete it when you no longer need it."
          detail="You won't be asked again."
          confirmLabel="Save copy"
          icon="file"
          onConfirm={() => { const a = exportWarn; setExportWarn(null); markWarned(); void doExport(a); }}
          onCancel={() => setExportWarn(null)}
        />
      )}
    </CollapsibleSection>
  );
}
