import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { open as pickFiles, save as pickSave } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp, Copy, Download, Eye, EyeOff, FilePenLine, FolderOpen, FolderPlus, Pencil, RefreshCw, Search, SquareArrowOutUpRight,
  Trash2, Upload,
} from "lucide-react";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Input } from "../ui/Input";
import { DropHighlight, useDropTarget } from "../ui/DropZone";
import { RowIconButton } from "../vault/ListEditor";
import { RemoteFileTable } from "./RemoteFileTable";
import { RemoteFileViewer } from "./RemoteFileViewer";
import { RemoteTransfers, type Transfer } from "./RemoteTransfers";
import { toast } from "../../lib/toast";
import { getFileName, joinPath } from "../../lib/pathUtils";
import type { SshTarget } from "../../lib/sshConnect";
import {
  crumbs, joinRemote, nameProblem, onSftpProgress, parentRemote, sftpCancel, sftpClose, sftpDownload, sftpErrorMessage,
  sftpList, sftpMkdir, sftpOpen, sftpRemove, sftpRename, sftpUpload, sortEntries, visibleEntries, SFTP_CANCELLED, SFTP_EXISTS,
  type RemoteEntry, type SortKey, type SortState,
} from "../../lib/sftp";

let nextSession = 1;
let nextTransfer = 1;

type Phase = "connecting" | "ready" | "failed";
type Prompt = { kind: "folder" } | { kind: "rename"; entry: RemoteEntry };

/** A one-field dialog for a new folder's name or a rename. */
function NameDialog({ title, label, initial, confirm, onSubmit, onClose }: {
  title: string; label: string; initial: string; confirm: string; onSubmit: (name: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const problem = value === initial && initial !== "" ? null : nameProblem(value);
  const submit = (e: FormEvent) => { e.preventDefault(); if (!nameProblem(value) && value.trim() !== initial) onSubmit(value.trim()); };
  return (
    <Dialog title={title} size="sm" onClose={onClose} onSubmit={submit} zClassName="z-[60]">
      <DialogBody>
        <label className="block text-sm mb-1.5" htmlFor="remote-name">{label}</label>
        <Input id="remote-name" value={value} autoFocus spellCheck={false} autoComplete="off"
               onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.currentTarget.select()} />
        {value !== initial && problem && <p className="mt-1.5 text-xs text-[var(--color-danger)]">{problem}</p>}
      </DialogBody>
      <DialogFooter>
        <DialogButton cancel onClick={onClose}>Cancel</DialogButton>
        <DialogButton variant="primary" type="submit" disabled={!!nameProblem(value) || value.trim() === initial}>{confirm}</DialogButton>
      </DialogFooter>
    </Dialog>
  );
}

/**
 * The remote file manager for a saved SSH entry: browse folders, upload and download (also by dropping files
 * on it), make folders, rename and delete. It signs in like the terminal does; the secrets never reach this code.
 * It fills its parent, so it works in a tab and in a window of its own. `active` is false while its tab is hidden
 * (the panel stays mounted so the connection and the folder survive a switch to another tab).
 */
export function RemoteFilesPanel({ target, active = true, onPopOut }: {
  target: SshTarget;
  active?: boolean;
  /** Offered in the toolbar when given: move this file manager to a window of its own. */
  onPopOut?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [failure, setFailure] = useState("");
  const [title, setTitle] = useState(target.title);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<SortState>({ key: "name", desc: false });
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [deleting, setDeleting] = useState<RemoteEntry[] | null>(null);
  const [replace, setReplace] = useState<{ name: string; answer: (yes: boolean) => void } | null>(null);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: RemoteEntry | null } | null>(null);
  /** The file open in the viewer, with the folder it is in. */
  const [viewing, setViewing] = useState<{ entry: RemoteEntry; dir: string } | null>(null);
  const { copy } = useCopyToClipboard();

  const rootEl = useRef<HTMLDivElement>(null);
  const sid = useRef(0);
  const anchor = useRef<string | null>(null);
  const pathRef = useRef("");
  pathRef.current = path;

  // ── connecting ───────────────────────────────────────────────────────────────

  const load = useCallback(async (want: string, session = sid.current) => {
    setLoading(true);
    try {
      const l = await sftpList(session, want);
      if (session !== sid.current) return;
      setPath(l.path); setEntries(l.entries); setSelected(new Set()); anchor.current = null;
    } catch (e) {
      if (session === sid.current) toast.error(sftpErrorMessage(e));
    } finally {
      if (session === sid.current) setLoading(false);
    }
  }, []);

  const connect = useCallback(async () => {
    const session = nextSession++;
    sid.current = session;
    setPhase("connecting"); setFailure("");
    try {
      const o = await sftpOpen(session, target.path, target.auth);
      if (session !== sid.current) { void sftpClose(session); return; }
      setTitle(o.title || target.title);
      setPhase("ready");
      await load(o.home, session);
    } catch (e) {
      if (session !== sid.current) return;
      setFailure(sftpErrorMessage(e)); setPhase("failed");
    }
  }, [target, load]);

  useEffect(() => {
    void connect();
    return () => { const s = sid.current; sid.current = 0; if (s) void sftpClose(s); };
  }, [connect]);

  // Progress events carry the transfer id; the list shows the latest of each.
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    void onSftpProgress((p) => setTransfers((ts) => ts.map((t) => (t.id === p.transfer && t.state === "running" ? { ...t, done: p.done, total: p.total } : t))))
      .then((u) => { if (dead) u(); else off = u; });
    return () => { dead = true; off?.(); };
  }, []);

  // ── what is shown ────────────────────────────────────────────────────────────

  const shown = useMemo(() => sortEntries(visibleEntries(entries, filter, showHidden), sort), [entries, filter, showHidden, sort]);
  const picked = useMemo(() => shown.filter((e) => selected.has(e.name)), [shown, selected]);
  const pickedFiles = picked.filter((e) => e.kind !== "dir");
  const ready = phase === "ready";

  const select = (name: string, mode: "single" | "toggle" | "range") => {
    if (mode === "range" && anchor.current) {
      const a = shown.findIndex((e) => e.name === anchor.current), b = shown.findIndex((e) => e.name === name);
      if (a >= 0 && b >= 0) { setSelected(new Set(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((e) => e.name))); return; }
    }
    anchor.current = name;
    setSelected((prev) => {
      if (mode === "toggle") { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; }
      return new Set([name]);
    });
  };

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: false }));
  const goUp = () => { if (path !== "/") void load(parentRemote(path)); };

  // ── transfers ────────────────────────────────────────────────────────────────

  const track = (t: Transfer) => setTransfers((ts) => [...ts, t]);
  const finish = (id: number, patch: Partial<Transfer>) => setTransfers((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const askReplace = (name: string) => new Promise<boolean>((resolve) => setReplace({ name, answer: resolve }));

  /** One transfer: runs it, and when the target exists asks whether to replace it, then runs it again. */
  const runTransfer = async (kind: "up" | "down", name: string, run: (id: number, overwrite: boolean) => Promise<number>) => {
    const id = nextTransfer++;
    track({ id, kind, name, done: 0, total: 0, state: "running" });
    try {
      await run(id, false);
      finish(id, { state: "done" });
    } catch (e) {
      const msg = sftpErrorMessage(e);
      if (msg === SFTP_CANCELLED) { finish(id, { state: "cancelled" }); return; }
      if (msg === SFTP_EXISTS) {
        if (!(await askReplace(name))) { finish(id, { state: "skipped" }); return; }
        try { await run(id, true); finish(id, { state: "done" }); }
        catch (e2) {
          const m2 = sftpErrorMessage(e2);
          finish(id, m2 === SFTP_CANCELLED ? { state: "cancelled" } : { state: "error", error: m2 });
        }
        return;
      }
      finish(id, { state: "error", error: msg });
    }
  };

  const upload = async (paths: string[]) => {
    if (!ready || paths.length === 0) return;
    const session = sid.current, dir = pathRef.current;
    for (const local of paths) {
      const name = getFileName(local);
      await runTransfer("up", name, (id, ow) => sftpUpload(session, id, local, joinRemote(dir, name), ow));
    }
    if (session === sid.current && pathRef.current === dir) void load(dir, session);
  };

  const chooseUpload = async () => {
    try {
      const sel = await pickFiles({ multiple: true, directory: false, title: `Upload to ${path}` });
      await upload(typeof sel === "string" ? [sel] : Array.isArray(sel) ? sel : []);
    } catch (e) { toast.error(sftpErrorMessage(e)); }
  };

  const download = async (files: RemoteEntry[]) => {
    if (!ready || files.length === 0) return;
    const session = sid.current, dir = pathRef.current;
    try {
      let locals: { entry: RemoteEntry; local: string }[];
      if (files.length === 1) {
        const dest = await pickSave({ title: "Save file", defaultPath: files[0].name });
        if (!dest) return;
        locals = [{ entry: files[0], local: dest }];
      } else {
        const folder = await pickFiles({ directory: true, multiple: false, title: `Save ${files.length} files in…` });
        if (typeof folder !== "string") return;
        locals = files.map((entry) => ({ entry, local: joinPath(folder, entry.name) }));
      }
      for (const { entry, local } of locals) {
        await runTransfer("down", entry.name, (id, ow) => sftpDownload(session, id, joinRemote(dir, entry.name), local, ow));
      }
    } catch (e) { toast.error(sftpErrorMessage(e)); }
  };

  /** A folder opens in the list; a file opens in the viewer (pictures shown, text edited); anything else is downloaded. */
  const openEntry = (e: RemoteEntry) => {
    if (e.kind === "dir") void load(joinRemote(path, e.name));
    else if (e.kind === "file") setViewing({ entry: e, dir: path });
    else void download([e]);
  };

  // Right-click: a row not in the selection becomes the selection first, like a file manager does.
  const openMenu = (entry: RemoteEntry | null, x: number, y: number) => {
    if (entry && !selected.has(entry.name)) select(entry.name, "single");
    setMenu({ x, y, entry });
  };

  const menuItems = (entry: RemoteEntry | null): ContextMenuItem[] => {
    const here: ContextMenuItem[] = [
      { type: "item", label: "Upload here\u2026", icon: <Upload size={13} />, onClick: () => void chooseUpload() },
      { type: "item", label: "New folder\u2026", icon: <FolderPlus size={13} />, onClick: () => setPrompt({ kind: "folder" }) },
      { type: "item", label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void load(path) },
      { type: "item", label: "Copy folder path", icon: <Copy size={13} />, onClick: () => void copy(path) },
    ];
    if (!entry) return here;
    // The menu acts on the whole selection when the clicked row is part of it.
    const group = selected.has(entry.name) && picked.length > 1 ? picked : [entry];
    const files = group.filter((e) => e.kind !== "dir");
    const one = group.length === 1;
    return [
      one && entry.kind === "dir"
        ? { type: "item", label: "Open", icon: <FolderOpen size={13} />, onClick: () => openEntry(entry) }
        : { type: "item", label: "Open / edit", icon: <FilePenLine size={13} />, disabled: !one || entry.kind !== "file", onClick: () => openEntry(entry) },
      { type: "item", label: files.length > 1 ? `Download ${files.length} files\u2026` : "Download\u2026", icon: <Download size={13} />, disabled: files.length === 0, onClick: () => void download(files) },
      { type: "separator" },
      { type: "item", label: "Rename\u2026", icon: <Pencil size={13} />, shortcut: "F2", disabled: !one, onClick: () => setPrompt({ kind: "rename", entry }) },
      { type: "item", label: "Copy path", icon: <Copy size={13} />, disabled: !one, onClick: () => void copy(joinRemote(path, entry.name)) },
      { type: "separator" },
      { type: "item", label: one ? "Delete\u2026" : `Delete ${group.length} items\u2026`, icon: <Trash2 size={13} />, shortcut: "Del", danger: true, onClick: () => setDeleting(group) },
      { type: "separator" },
      ...here,
    ];
  };

  // ── changing things on the server ────────────────────────────────────────────

  const act = async (job: () => Promise<void>, done?: string) => {
    try { await job(); if (done) toast.success(done); await load(pathRef.current); }
    catch (e) { toast.error(sftpErrorMessage(e)); }
  };

  const makeFolder = (name: string) => { setPrompt(null); void act(() => sftpMkdir(sid.current, joinRemote(path, name))); };
  const renameEntry = (e: RemoteEntry, name: string) => {
    setPrompt(null); void act(() => sftpRename(sid.current, joinRemote(path, e.name), joinRemote(path, name)));
  };
  const removeEntries = (list: RemoteEntry[]) => {
    setDeleting(null);
    void act(async () => { for (const e of list) await sftpRemove(sid.current, joinRemote(path, e.name)); },
      list.length === 1 ? `Deleted ${list[0].name}` : `Deleted ${list.length} items`);
  };

  const dropping = useDropTarget({ id: `remote-files-${target.path}-${target.auth}`, element: () => rootEl.current, enabled: ready && active, onDrop: (p) => void upload(p) });

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "Delete" && picked.length) { e.preventDefault(); setDeleting(picked); }
    else if (e.key === "F2" && picked.length === 1) { e.preventDefault(); setPrompt({ kind: "rename", entry: picked[0] }); }
    else if (e.key === "Enter" && picked.length === 1) { e.preventDefault(); openEntry(picked[0]); }
    else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); goUp(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(shown.map((x) => x.name))); }
  };

  // Why nothing is listed: an empty folder, only dot files that are hidden, or a filter that matches nothing.
  const emptyText = entries.length === 0 ? "This folder is empty."
    : !showHidden && entries.every((e) => e.name.startsWith(".")) && !filter.trim()
      ? "Only hidden (dot) files here. Use the eye button to show them."
      : "Nothing matches the filter.";
  const count = entries.length;
  const status = !ready ? "" : loading ? "Loading…"
    : `${count} item${count === 1 ? "" : "s"}${picked.length ? ` · ${picked.length} selected` : ""}`;

  return (
    <>
      <div ref={rootEl} className="relative flex flex-col h-full min-h-0 bg-[var(--color-bg)] outline-none" tabIndex={-1}
           data-remote-drop="" data-testid="remote-files" aria-label={`Files on ${title}`} onKeyDown={onKey}>
            {phase === "connecting" && (
              <p className="m-auto text-sm text-[var(--color-text-muted)]" role="status">Connecting to {target.title}…</p>
            )}
            {phase === "failed" && (
              <div className="m-auto max-w-md text-center px-6" role="alert">
                <p className="text-sm font-medium">Couldn't open the file manager</p>
                <p className="mt-2 text-sm text-[var(--color-text-muted)] whitespace-pre-wrap">{failure}</p>
                <div className="mt-4 flex justify-center"><DialogButton variant="primary" onClick={() => void connect()}>Try again</DialogButton></div>
              </div>
            )}
            {ready && (
              <>
                <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--color-border)]">
                  <RowIconButton label="Up one folder" tooltip="Up (Backspace)" icon={<ArrowUp size={14} />} disabled={path === "/"} onClick={goUp} />
                  <RowIconButton label="Refresh" icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />} onClick={() => void load(path)} />
                  {editingPath === null ? (
                    <nav aria-label="Folder path" className="flex-1 min-w-0 flex items-center overflow-x-auto h-8 rounded-md px-1.5 border border-[var(--color-border)] bg-[var(--color-bg-secondary)] cursor-text"
                         onDoubleClick={() => setEditingPath(path)}>
                      {crumbs(path).map((c, i, all) => (
                        <span key={c.path} className="flex items-center shrink-0">
                          <button type="button" onClick={() => void load(c.path)}
                                  className={`px-1.5 py-0.5 rounded text-sm cursor-pointer hover:bg-[var(--color-bg-tertiary)] ${i === all.length - 1 ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                            {c.name}
                          </button>
                          {i > 0 && i < all.length - 1 && <span className="text-[var(--color-text-muted)]" aria-hidden>/</span>}
                        </span>
                      ))}
                    </nav>
                  ) : (
                    <Input className="flex-1 min-w-0 font-mono" value={editingPath} autoFocus spellCheck={false} aria-label="Folder path"
                           onChange={(e) => setEditingPath(e.target.value)} onFocus={(e) => e.currentTarget.select()}
                           onBlur={() => setEditingPath(null)}
                           onKeyDown={(e) => {
                             if (e.key === "Enter") { const p = editingPath.trim(); setEditingPath(null); if (p) void load(p); }
                             if (e.key === "Escape") { e.stopPropagation(); setEditingPath(null); }
                           }} />
                  )}
                  <div className="relative w-44 shrink-0">
                    <Search size={13} aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <Input className="!pl-7" value={filter} placeholder="Filter" aria-label="Filter files" spellCheck={false}
                           onChange={(e) => setFilter(e.target.value)} />
                  </div>
                  <RowIconButton label={showHidden ? "Hide dot files" : "Show dot files"} icon={showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                                 pressed={showHidden} onClick={() => setShowHidden((v) => !v)} />
                  {onPopOut && <RowIconButton label="Open in new window" icon={<SquareArrowOutUpRight size={14} />} onClick={onPopOut} />}
                </div>

                <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--color-border)]">
                  <DialogButton icon={<Upload size={13} />} onClick={() => void chooseUpload()}>Upload</DialogButton>
                  <DialogButton icon={<Download size={13} />} disabled={pickedFiles.length === 0} onClick={() => void download(pickedFiles)}>
                    Download{pickedFiles.length > 1 ? ` (${pickedFiles.length})` : ""}
                  </DialogButton>
                  <span className="w-px h-5 mx-1 bg-[var(--color-border)]" aria-hidden />
                  <DialogButton icon={<FolderPlus size={13} />} onClick={() => setPrompt({ kind: "folder" })}>New folder</DialogButton>
                  <DialogButton icon={<Pencil size={13} />} disabled={picked.length !== 1} onClick={() => setPrompt({ kind: "rename", entry: picked[0] })}>Rename</DialogButton>
                  <DialogButton variant={picked.length === 0 ? "secondary" : "danger"} icon={<Trash2 size={13} />} disabled={picked.length === 0} onClick={() => setDeleting(picked)}>Delete</DialogButton>
                </div>

                <RemoteFileTable entries={shown} selected={selected} sort={sort} onSort={sortBy} onSelect={select} onOpen={openEntry} onMenu={openMenu}
                                 empty={emptyText} />
              </>
            )}
            <RemoteTransfers items={transfers}
                             onCancel={(id) => void sftpCancel(id)}
                             onClear={() => setTransfers((ts) => ts.filter((t) => t.state === "running"))} />
            {viewing && (
              <RemoteFileViewer session={sid.current} path={joinRemote(viewing.dir, viewing.entry.name)} name={viewing.entry.name}
                                onClose={() => setViewing(null)} onDownload={() => void download([viewing.entry])}
                                onSaved={() => void load(pathRef.current)} />
            )}
            {dropping && <DropHighlight icon={<Upload size={16} />}>Drop files to upload to {path}</DropHighlight>}
        <div className="shrink-0 flex items-center h-7 px-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]" role="status">
          {status || `Files on ${title}`}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} label={menu.entry ? `Actions for ${menu.entry.name}` : "Folder actions"} />}
      {prompt?.kind === "folder" && (
        <NameDialog title="New folder" label="Folder name" initial="" confirm="Create" onSubmit={makeFolder} onClose={() => setPrompt(null)} />
      )}
      {prompt?.kind === "rename" && (
        <NameDialog title="Rename" label="New name" initial={prompt.entry.name} confirm="Rename"
                    onSubmit={(n) => renameEntry(prompt.entry, n)} onClose={() => setPrompt(null)} />
      )}
      {deleting && (
        <ConfirmDialog title={deleting.length === 1 ? `Delete ${deleting[0].name}?` : `Delete ${deleting.length} items?`}
                       message={deleting.some((e) => e.kind === "dir")
                         ? "Folders are deleted with everything inside them. This can't be undone."
                         : "This can't be undone."}
                       detail={`On ${title}, in ${path}`} icon="danger" danger confirmLabel="Delete"
                       onConfirm={() => removeEntries(deleting)} onCancel={() => setDeleting(null)} />
      )}
      {replace && (
        <ConfirmDialog title={`Replace ${replace.name}?`} message="A file with this name is already there."
                       confirmLabel="Replace" cancelLabel="Skip" danger
                       onConfirm={() => { replace.answer(true); setReplace(null); }}
                       onCancel={() => { replace.answer(false); setReplace(null); }} />
      )}
    </>
  );
}
