import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Eye, Paperclip, Trash2, TriangleAlert, X } from "lucide-react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, stat } from "@tauri-apps/plugin-fs";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Spinner } from "../ui/Loading";
import { CollapsibleSection } from "./EntryParts";
import { AttachmentIcon, AttachmentPreview } from "./AttachmentPreview";
import { AddRowButton, RowActions, RowIconButton, useAnnouncer, useLatest, useListFocus, useUndoToast } from "./ListEditor";
import { useAppStore } from "../../store";
import { useVaultStore } from "../../store/vaultStore";
import { toast } from "../../lib/toast";
import { formatBytes } from "../../lib/vaultBackup";
import { resolveVaultDir } from "../../lib/vaultDir";
import { entryTitleOf } from "../../lib/entryName";
import { previewMode } from "../../lib/attachmentKinds";
import { registerDropTarget } from "../../lib/dropTargets";
import { registerVaultFlush } from "../../lib/vaultPendingOps";
import { attachmentLimitError, fileNameOf, vaultAttachmentsUsed } from "../../lib/attachmentLimits";
import {
  bytesToBase64, isVaultPath, vaultAttachAdd, vaultAttachExport, vaultAttachList, vaultAttachRemove, vaultErrorMessage,
  VAULT_ATTACH_MAX_BYTES, VAULT_ATTACH_MAX_PER_NOTE, VAULT_ATTACH_MAX_TOTAL, type VaultAttachment,
} from "../../lib/vault";
import { ATTACHMENT_LIMITS_TEXT } from "../../lib/vaultSync";
import type { Tab } from "../../types";

export const ATTACHMENTS_SYNC_NOTE = `${ATTACHMENT_LIMITS_TEXT} With Vault Sync on, attachments sync to your other devices too.`;

/** How long a removal waits (and Undo is offered) before it is applied to the vault. */
export const REMOVE_UNDO_MS = 6000;
export const FOLDER_ERROR = "Folders can't be attached. Drop or choose the files inside it instead";

const EXPORT_WARNED_KEY = "notiq.vault.attachExportWarned";
const wasWarned = () => { try { return localStorage.getItem(EXPORT_WARNED_KEY) === "1"; } catch { return false; } };
const markWarned = () => { try { localStorage.setItem(EXPORT_WARNED_KEY, "1"); } catch { /* private storage */ } };

/** Saves the tab first when it has unsaved edits (attachments act on the stored entry). */
async function ensureSaved(tabId: string): Promise<string | null> {
  const st = useAppStore.getState();
  const cur = st.tabs.find((t) => t.id === tabId);
  if (!cur || !isVaultPath(cur.filePath)) return null;
  if (cur.isDirty && !(await st.saveTabToFile(tabId))) return null;
  // Saving can rename the entry to its Name, so read the path again.
  return useAppStore.getState().tabs.find((t) => t.id === tabId)?.filePath ?? null;
}

/** The tab's path right now (it changes when a save renames the entry). */
const pathOf = (tabId: string) => useAppStore.getState().tabs.find((t) => t.id === tabId)?.filePath;

const errorText = (e: unknown) => (e instanceof Error ? e.message : vaultErrorMessage(e));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const without = (s: ReadonlySet<string>, id: string) => { const n = new Set(s); n.delete(id); return n; };

/** A file being added, or one that couldn't be (shown inline until dismissed or the next add). */
interface Job { key: string; name: string; status: "waiting" | "adding" | "error"; error?: string }

/** Display name of the entry, for "Drop to attach to …" and labels. */
export function entryDisplayName(tab: Pick<Tab, "content" | "title">): string {
  return (entryTitleOf(tab.content) ?? "").trim() || tab.title.replace(/\.nqv$/i, "").trim() || "this entry";
}

/**
 * Collapsible "Attachments (n)" section for a structured vault entry. Files are stored encrypted in the
 * vault. Files can be added with the Add button or dropped from the OS anywhere on the entry form.
 * Keyed by tab so pending removals and Undo never carry over to another entry.
 */
export function AttachmentsPanel({ tab }: { tab: Tab }) {
  return <AttachmentsPanelInner key={tab.id} tab={tab} />;
}

function AttachmentsPanelInner({ tab }: { tab: Tab }) {
  const path = tab.filePath;
  const name = entryDisplayName(tab);
  const [open_, setOpen] = useState(false);
  const [list, setList] = useState<VaultAttachment[] | null>(null);
  const [vaultUsed, setVaultUsed] = useState<number | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [hover, setHover] = useState(false);
  const [preview, setPreview] = useState<{ path: string; a: VaultAttachment } | null>(null);
  const [exportWarn, setExportWarn] = useState<VaultAttachment | null>(null);
  /** Removed but still undoable: hidden here, applied to the vault when the Undo window ends. */
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const pending = useRef(new Map<string, { a: VaultAttachment; path?: string; timer: ReturnType<typeof setTimeout> }>());
  const mounted = useRef(true);
  const focusId = useRef<string | null>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const [dropHost, setDropHost] = useState<HTMLElement | null>(null);
  const hintId = useId();

  const { announce, region } = useAnnouncer();
  const { rootRef, focusAfter } = useListFocus<HTMLDivElement>();
  const undoToast = useUndoToast();
  const unlocked = useVaultStore((s) => s.unlocked);
  const active = useAppStore((s) => s.activeTabId === tab.id);
  const canDrop = unlocked && active && !tab.vaultLocked && isVaultPath(path);
  const canDropRef = useLatest(canDrop);

  const reload = useCallback(async (): Promise<VaultAttachment[]> => {
    const p = pathOf(tab.id);
    let next: VaultAttachment[] = [];
    if (p && isVaultPath(p)) { try { next = await vaultAttachList(p); } catch { /* locked or gone */ } }
    if (mounted.current) setList(next);
    return next;
  }, [tab.id]);

  const reloadUsed = useCallback(async () => {
    try { setVaultUsed(await vaultAttachmentsUsed(await resolveVaultDir())); } catch { setVaultUsed(null); }
  }, []);

  useEffect(() => { void reload(); }, [reload, path]);
  useEffect(() => { if (open_) void reloadUsed(); }, [open_, reloadUsed]);

  // ── Removal with Undo ──────────────────────────────────────────────────────
  // The backend wipes a removed file's data, so instead of keeping a decrypted copy around for Undo,
  // the removal itself waits: Undo just cancels it. It is applied when the window ends, when the panel
  // goes away (another tab, the vault locking) or before new files are added.

  const commitRemoval = useCallback(async (id: string) => {
    const p = pending.current.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.current.delete(id);
    try {
      // The tab may be closing (unmount flush): fall back to where the entry was when it was removed.
      const target = pathOf(tab.id) ?? p.path;
      if (!target) throw new Error("The entry is no longer open");
      await vaultAttachRemove(target, id);
      if (mounted.current) setVaultUsed((u) => (u === null ? u : Math.max(0, u - p.a.size)));
    } catch (e) {
      toast.error(`Couldn't remove ${p.a.name}: ${errorText(e)}`);
    }
    if (mounted.current) { await reload(); setHidden((h) => without(h, id)); }
  }, [reload, tab.id]);

  const flushRemovals = useCallback(async () => {
    await Promise.all([...pending.current.keys()].map((id) => commitRemoval(id)));
  }, [commitRemoval]);
  const flushRef = useLatest(flushRemovals);

  useEffect(() => registerVaultFlush(() => flushRef.current()), [flushRef]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; void flushRef.current(); };
  }, [flushRef]);

  const remove = (a: VaultAttachment, index: number) => {
    const timer = setTimeout(() => { void commitRemoval(a.id); }, REMOVE_UNDO_MS);
    pending.current.set(a.id, { a, path: pathOf(tab.id), timer });
    setHidden((h) => new Set(h).add(a.id));
    focusAfter({ index });
    announce(`Removed ${a.name}. Undo is available for a few seconds.`);
    undoToast(`Removed ${a.name}`, () => {
      const p = pending.current.get(a.id);
      if (!p) { toast.info(`${a.name} was already removed`); return; }
      clearTimeout(p.timer);
      pending.current.delete(a.id);
      if (!mounted.current) return;
      setHidden((h) => without(h, a.id));
      focusId.current = a.id;
      announce(`Restored ${a.name}`);
    });
  };

  // ── Adding ─────────────────────────────────────────────────────────────────

  const attach = async (paths: string[]) => {
    if (paths.length === 0) return;
    if (busyRef.current) { announce("Still adding files. Try again when that finishes."); return; }
    busyRef.current = true;
    setBusy(true);
    setOpen(true);
    const stamp = Date.now();
    const batch: Job[] = paths.map((p, i) => ({ key: `${stamp}-${i}`, name: fileNameOf(p), status: "waiting" }));
    setJobs(batch); // replaces the errors of the previous add
    const patch = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));
    const done = new Set<string>();
    const failures: Job[] = [];
    let lastAdded: string | null = null;
    try {
      await flushRemovals(); // so the limits below see the real count
      const target = await ensureSaved(tab.id);
      if (!target) throw new Error("Save this entry first, then add attachments");
      let count = (await vaultAttachList(target)).length;
      let used = await vaultAttachmentsUsed(await resolveVaultDir());
      for (let i = 0; i < paths.length; i++) {
        const job = batch[i];
        patch(job.key, { status: "adding" });
        try {
          const info = await stat(paths[i]);
          if (info.isDirectory) throw new Error(FOLDER_ERROR);
          const why = attachmentLimitError(info.size, count, used);
          if (why) throw new Error(why);
          // Bytes live only in this scope: read → encode → send, then they're garbage.
          const meta = await vaultAttachAdd(target, job.name, bytesToBase64(await readFile(paths[i])));
          count++; used += info.size;
          lastAdded = meta.id;
          setJobs((js) => js.filter((j) => j.key !== job.key));
        } catch (e) {
          const f = { ...job, status: "error" as const, error: errorText(e) };
          failures.push(f);
          patch(job.key, f);
        }
        done.add(job.key);
      }
      if (mounted.current) setVaultUsed(used);
    } catch (e) {
      // Nothing more can be added (entry not saved, vault locked…): fail what's left.
      const error = errorText(e);
      for (const j of batch) if (!done.has(j.key)) failures.push({ ...j, status: "error", error });
      setJobs((js) => js.map((j) => (done.has(j.key) ? j : { ...j, status: "error", error })));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
    focusId.current = lastAdded;
    await reload();
    const added = paths.length - failures.length;
    const parts: string[] = [];
    if (added) parts.push(`Attached ${plural(added, "file")} to ${name}.`);
    if (failures.length === 1) parts.push(`Couldn't attach ${failures[0].name}: ${failures[0].error}.`);
    else if (failures.length) parts.push(`${plural(failures.length, "file")} couldn't be attached.`);
    announce(parts.join(" "));
    if (added) toast.success(added === 1 ? "Attachment added" : `${added} attachments added`);
  };
  const attachRef = useLatest(attach);

  const pick = async () => {
    if (busyRef.current) { announce("Still adding files. Try again when that finishes."); return; }
    const picked = await open({ multiple: true, directory: false, title: `Attach files to ${name}` });
    const files = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    await attach(files);
  };

  // ── Drag and drop (OS files, routed by the global handler in hooks/useAppStartup) ──

  useLayoutEffect(() => {
    setDropHost(sectionRef.current?.closest<HTMLElement>("[data-entry-drop]") ?? null);
  }, []);

  useEffect(() => registerDropTarget({
    id: `vault-attachments-${tab.id}`,
    element: () => dropHost ?? sectionRef.current,
    enabled: () => canDropRef.current,
    onHover: setHover,
    onDrop: (paths) => {
      sectionRef.current?.scrollIntoView?.({ block: "nearest" });
      void attachRef.current(paths);
    },
  }), [tab.id, dropHost, canDropRef, attachRef]);

  // Focus the row that was just added or restored, once it has rendered.
  useLayoutEffect(() => {
    const id = focusId.current;
    if (!id) return;
    const row = rootRef.current?.querySelector(`[data-att-id="${id}"]`);
    if (!row) return;
    focusId.current = null;
    row.querySelector<HTMLElement>("[data-row-focus]")?.focus();
  });

  // ── Export / open ──────────────────────────────────────────────────────────

  const doExport = async (a: VaultAttachment) => {
    const p = pathOf(tab.id);
    if (!p) return;
    try {
      const dest = await save({ defaultPath: a.name, title: `Save "${a.name}"` });
      if (!dest) return;
      // The OS save dialog already asked about replacing an existing file.
      await vaultAttachExport(p, a.id, dest, true);
      toast.success(`Saved ${a.name}`);
    } catch (e) {
      toast.error(`Couldn't save the file: ${vaultErrorMessage(e)}`);
    }
  };

  const requestExport = (a: VaultAttachment) => {
    if (wasWarned()) void doExport(a);
    else setExportWarn(a);
  };

  const dismissJob = (key: string) => {
    setJobs((js) => js.filter((j) => j.key !== key));
    focusAfter("add");
  };

  const visible = (list ?? []).filter((a) => !hidden.has(a.id));
  const n = visible.length;
  const entryBytes = visible.reduce((s, a) => s + a.size, 0);
  const full = n >= VAULT_ATTACH_MAX_PER_NOTE;
  const showDrop = hover && canDrop && dropHost;

  return (
    <div ref={sectionRef} data-attachments="">
      <CollapsibleSection id={`att-${tab.id}`} title={`Attachments (${n})`}
                          summary={n ? formatBytes(entryBytes) : "Drop files here to keep them encrypted with this entry"}
                          open={open_} onToggle={() => setOpen((v) => !v)}>
        <div ref={rootRef} role="group" aria-label={`Attachments of ${name}`} aria-describedby={hintId} aria-busy={busy || undefined}
             className="flex flex-col gap-2">
          {n === 0 && jobs.length === 0 && (
            <div data-empty="" className="flex flex-col items-center gap-1 rounded-md border border-dashed border-[var(--color-border)] px-4 py-5 text-center">
              <Paperclip size={18} aria-hidden className="text-[var(--color-text-muted)]" />
              <p className="text-sm text-[var(--color-text)]">Drop files here or Add file</p>
              <p className="text-[11px] text-[var(--color-text-muted)]">
                A scan, key file or document. It's stored encrypted inside the vault with this entry.
              </p>
            </div>
          )}

          {n > 0 && (
            <ul aria-label="Attached files" className="flex flex-col rounded-md border border-[var(--color-border)] divide-y divide-[var(--color-border)]">
              {visible.map((a, i) => {
                const canOpen = previewMode(a.name, a.mime) !== null;
                return (
                  <li key={a.id} data-list-row="" data-att-id={a.id} className="flex items-center gap-2.5 px-2.5 py-1.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]">
                      <AttachmentIcon name={a.name} mime={a.mime} size={15} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm truncate" title={a.name}>{a.name}</div>
                      <div className="text-[11px] text-[var(--color-text-muted)]">
                        {formatBytes(a.size)} · added {new Date(a.added).toLocaleDateString()}
                      </div>
                    </div>
                    <RowActions>
                      {canOpen && (
                        <RowIconButton data-row-focus="" label={`Open ${a.name}`} tooltip="Open (decrypted in memory only)"
                                       icon={<Eye size={13} />}
                                       onClick={() => { const p = pathOf(tab.id); if (p) setPreview({ path: p, a }); }} />
                      )}
                      <RowIconButton data-row-focus={canOpen ? undefined : ""} label={`Save ${a.name} as`} tooltip="Save a copy to disk"
                                     icon={<Download size={13} />} onClick={() => requestExport(a)} />
                      <RowIconButton danger label={`Remove ${a.name}`} tooltip="Remove attachment"
                                     icon={<Trash2 size={13} />} onClick={() => remove(a, i)} />
                    </RowActions>
                  </li>
                );
              })}
            </ul>
          )}

          {jobs.length > 0 && (
            <ul aria-label="Files being added" className="flex flex-col gap-1">
              {jobs.map((j) => (
                <li key={j.key} data-job={j.status}
                    className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 border ${j.status === "error"
                      ? "border-[var(--color-danger)]/40 bg-[var(--color-danger)]/5"
                      : "border-[var(--color-border)] bg-[var(--color-bg-secondary)]"}`}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                    {j.status === "error"
                      ? <TriangleAlert size={15} aria-hidden className="text-[var(--color-danger)]" />
                      : <Spinner size={15} />}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" title={j.name}>{j.name}</div>
                    <div className={`text-[11px] ${j.status === "error" ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]"}`}>
                      {j.status === "error" ? j.error : j.status === "adding" ? "Encrypting and adding…" : "Waiting…"}
                    </div>
                  </div>
                  {j.status === "error" && (
                    <RowActions>
                      <RowIconButton label={`Dismiss error for ${j.name}`} tooltip="Dismiss" icon={<X size={13} />}
                                     onClick={() => dismissJob(j.key)} />
                    </RowActions>
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <AddRowButton onAdd={() => { void pick(); }} atLimit={full} tooltip="Choose files to attach"
                          limitText={`An entry can have at most ${VAULT_ATTACH_MAX_PER_NOTE} attachments. Remove one to add another.`}>
              {busy ? "Adding…" : "Add file"}
            </AddRowButton>
            <span className="text-[11px] text-[var(--color-text-muted)]">
              {n}/{VAULT_ATTACH_MAX_PER_NOTE} files · {formatBytes(entryBytes)}
              {vaultUsed !== null && ` · ${formatBytes(vaultUsed)} of ${formatBytes(VAULT_ATTACH_MAX_TOTAL)} used in the vault`}
              {` · up to ${formatBytes(VAULT_ATTACH_MAX_BYTES)} each`}
            </span>
          </div>
          <p id={hintId} className="text-[11px] text-[var(--color-text-muted)]">
            You can also drop files from your computer anywhere on this entry. {ATTACHMENTS_SYNC_NOTE}
          </p>
        </div>
      </CollapsibleSection>
      {region}

      {showDrop && createPortal(
        <div data-drop-highlight=""
             className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-lg border-2 border-dashed border-[var(--color-primary)] bg-[var(--color-primary)]/10">
          <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium shadow-md bg-[var(--color-bg-secondary)] text-[var(--color-text)] border border-[var(--color-border)]">
            <Paperclip size={14} aria-hidden className="text-[var(--color-primary)]" />
            {busy ? "Still adding files…" : `Drop to attach to ${name}`}
          </div>
        </div>,
        dropHost,
      )}

      {preview && (
        <AttachmentPreview path={preview.path} attachment={preview.a} onClose={() => setPreview(null)}
                           onSave={() => { const a = preview.a; setPreview(null); requestExport(a); }} />
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
    </div>
  );
}
