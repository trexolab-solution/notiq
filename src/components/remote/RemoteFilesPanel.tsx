import { useEffect, useMemo, useRef, useState } from "react";
import { open as pickFiles, save as pickSave } from "@tauri-apps/plugin-dialog";
import { Upload } from "lucide-react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu } from "../ui/ContextMenu";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { DropHighlight, useDropTarget } from "../ui/DropZone";
import { RemoteFileTable } from "./RemoteFileTable";
import { RemoteFileGrid } from "./RemoteFileGrid";
import { stepSize } from "./ViewSwitcher";
import { RemoteFileViewer } from "./RemoteFileViewer";
import { PermissionsDialog } from "./PermissionsDialog";
import { RemoteTrashSheet } from "./RemoteTrashSheet";
import type { EntryDrag, EntryDrop } from "./useEntryDnd";
import { RemoteTransfers } from "./RemoteTransfers";
import { toast } from "../../lib/toast";
import { getFilesPrefs, setFilesPrefs, type FilesView, type GridSize } from "../../lib/filesPrefs";
import { getFileName, joinPath } from "../../lib/pathUtils";
import type { SshTarget } from "../../lib/sshConnect";
import {
  clipboardFiles, joinRemote, parentRemote, sftpCancel, sftpDownload, sftpErrorMessage,
  sftpChmod, sftpMkdir, sftpMove, sftpRemove, sftpRename, sftpTrash, sftpTrashList, sftpUpload, sftpWrite, sortEntries, visibleEntries, isConnectionError, SFTP_EXISTS, SFTP_TRASH_FAILED,
  type RemoteEntry, type SortKey, type SortState,
} from "../../lib/sftp";
import { deleteMessage, deleteTitle } from "./panel/deleteText";
import { NameDialog } from "./panel/NameDialog";
import { RemotePathBar } from "./panel/RemotePathBar";
import { RemoteActionsToolbar } from "./panel/RemoteActionsToolbar";
import { MoveConflictDialog, ReplaceDialog, type MoveConflictAsk } from "./panel/ConflictDialogs";
import { ConnectFailed, ConnectingNote, ConnectionBanner } from "./panel/ConnectionStatus";
import { remoteMenuItems } from "./panel/remoteMenu";
import { useSftpSession } from "./panel/useSftpSession";
import { useTransfers } from "./panel/useTransfers";
import type { MoveChoice, Prompt } from "./panel/types";

export { deleteTitle, deleteMessage } from "./panel/deleteText";

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
  const {
    phase, failure, title, path, entries, loading, selected, setSelected, link, nav, setNav, trashCount, setTrashCount,
    sid, anchor, pathRef, reconnectRef, load, connect, reconnect,
  } = useSftpSession(target, active);
  const { transfers, runTransfer, clearFinished, replace, setReplace } = useTransfers(reconnectRef);
  const [sort, setSort] = useState<SortState>(() => { const p = getFilesPrefs(); return { key: p.sortKey, desc: p.sortDesc }; });
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(() => getFilesPrefs().showHidden);
  const [view, setViewState] = useState<FilesView>(() => getFilesPrefs().view);
  const [gridSize, setGridSizeState] = useState<GridSize>(() => getFilesPrefs().gridSize);
  // The layout is remembered: the last one picked here is what the next file manager opens with.
  const setView = (v: FilesView) => { setViewState(v); setFilesPrefs({ view: v }); };
  const setGridSize = (v: GridSize) => { setGridSizeState(v); setFilesPrefs({ gridSize: v }); };
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [deleting, setDeleting] = useState<RemoteEntry[] | null>(null);
  const [moveConflict, setMoveConflict] = useState<MoveConflictAsk | null>(null);
  const applyAll = useRef(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: RemoteEntry | null } | null>(null);
  /** The file open in the viewer, with the folder it is in. */
  const [viewing, setViewing] = useState<{ entry: RemoteEntry; dir: string } | null>(null);
  const { copy } = useCopyToClipboard();
  /** Items cut for moving: where they are and their names. */
  const [clip, setClip] = useState<{ dir: string; names: string[]; /** What the system clipboard held when these were cut. */ osSig: string } | null>(null);
  const [showTrash, setShowTrash] = useState(false);
  /** The items being dragged (to move them into a folder). */
  const [dragNames, setDragNames] = useState<string[] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const rootEl = useRef<HTMLDivElement>(null);

  // Ctrl+F (Cmd+F) goes to this file manager's own Filter box, not to the web view's find bar. The editor of an open
  // file keeps its own find, and so does any dialog on top.
  useEffect(() => {
    if (phase !== "ready" || !active || viewing) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      if (document.querySelector('[role="dialog"]')) return;
      const box = rootEl.current?.querySelector<HTMLInputElement>('input[aria-label="Filter files"]');
      if (!box) return;
      e.preventDefault();
      e.stopPropagation();
      box.focus();
      box.select();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [phase, active, viewing]);

  // ── what is shown ────────────────────────────────────────────────────────────

  const shown = useMemo(() => sortEntries(visibleEntries(entries, filter, showHidden), sort), [entries, filter, showHidden, sort]);
  const picked = useMemo(() => shown.filter((e) => selected.has(e.name)), [shown, selected]);
  const pickedFiles = picked.filter((e) => e.kind !== "other");
  const ready = phase === "ready";
  const trashOn = getFilesPrefs().useTrash;

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
  /** Goes to a folder and remembers where it came from for the back button. */
  const navigate = (want: string) => {
    const here = pathRef.current;
    setNav((n) => ({ back: here ? [...n.back, here] : n.back, fwd: [] }));
    void load(want);
  };
  const goBack = () => {
    const prev = nav.back[nav.back.length - 1];
    if (prev === undefined) return;
    setNav({ back: nav.back.slice(0, -1), fwd: [...nav.fwd, pathRef.current] });
    void load(prev);
  };
  const goForward = () => {
    const next = nav.fwd[nav.fwd.length - 1];
    if (next === undefined) return;
    setNav({ back: [...nav.back, pathRef.current], fwd: nav.fwd.slice(0, -1) });
    void load(next);
  };
  const goUp = () => { if (path !== "/") navigate(parentRemote(path)); };

  /** When each upload request started, so the very same request arriving twice (a doubled drop event) runs once. */
  const recentUploads = useRef(new Map<string, number>());
  const upload = async (paths: string[], to?: string) => {
    if (!ready || paths.length === 0) return;
    const session = sid.current, dir = to ?? pathRef.current;
    const key = `${session}\n${dir}\n${paths.join("\n")}`, now = Date.now();
    const seen = recentUploads.current.get(key);
    if (seen !== undefined && now - seen < 1500) return;
    recentUploads.current.set(key, now);
    for (const local of paths) {
      const name = getFileName(local);
      await runTransfer("up", name, (id, ow, merge) => sftpUpload(session, id, local, joinRemote(dir, name), ow, merge));
    }
    if (session === sid.current && pathRef.current === dir) void load(dir, session);
  };

  const chooseUploadFolder = async () => {
    try {
      const sel = await pickFiles({ multiple: true, directory: true, title: `Upload folders to ${path}` });
      await upload(typeof sel === "string" ? [sel] : Array.isArray(sel) ? sel : []);
    } catch (e) { toast.error(sftpErrorMessage(e)); }
  };

  const chooseUpload = async () => {
    try {
      const sel = await pickFiles({ multiple: true, directory: false, title: `Upload to ${path}` });
      await upload(typeof sel === "string" ? [sel] : Array.isArray(sel) ? sel : []);
    } catch (e) { toast.error(sftpErrorMessage(e)); }
  };

  /** Downloads files and folders: one file asks where to save it; anything else asks for the folder to save into. */
  const download = async (items: RemoteEntry[]) => {
    const list = items.filter((e) => e.kind !== "other");
    if (!ready || list.length === 0) return;
    const session = sid.current, dir = pathRef.current;
    try {
      let locals: { entry: RemoteEntry; local: string }[];
      if (list.length === 1 && list[0].kind === "file") {
        const dest = await pickSave({ title: "Save file", defaultPath: list[0].name });
        if (!dest) return;
        locals = [{ entry: list[0], local: dest }];
      } else {
        const folder = await pickFiles({ directory: true, multiple: false, title: list.length === 1 ? `Save \u201c${list[0].name}\u201d in\u2026` : `Save ${list.length} items in\u2026` });
        if (typeof folder !== "string") return;
        locals = list.map((entry) => ({ entry, local: joinPath(folder, entry.name) }));
      }
      for (const { entry, local } of locals) {
        await runTransfer("down", entry.name, (id, ow, merge) => sftpDownload(session, id, joinRemote(dir, entry.name), local, ow, merge));
      }
    } catch (e) { toast.error(sftpErrorMessage(e)); }
  };

  /** A folder opens in the list; a file opens in the viewer (pictures shown, text edited); anything else is downloaded. */
  const openEntry = (e: RemoteEntry) => {
    if (e.kind === "dir") navigate(joinRemote(path, e.name));
    else if (e.kind === "file") { if (getFilesPrefs().openAction === "download") void download([e]); else setViewing({ entry: e, dir: path }); }
    else void download([e]);
  };

  // Right-click: a row not in the selection becomes the selection first, like a file manager does.
  const openMenu = (entry: RemoteEntry | null, x: number, y: number) => {
    if (entry && !selected.has(entry.name)) select(entry.name, "single");
    setMenu({ x, y, entry });
  };

  // ── changing things on the server ────────────────────────────────────────────

  // One change at a time: a second click or key press while one is running must not run it again.
  const acting = useRef(false);
  const act = async (job: () => Promise<void>, done?: string) => {
    if (acting.current) return;
    acting.current = true;
    try { await job(); if (done) toast.success(done); await load(pathRef.current); }
    catch (e) {
      const m = sftpErrorMessage(e);
      if (isConnectionError(m)) { toast.error("The connection to the server was lost. Reconnecting\u2026 Run that again once it is back."); reconnectRef.current(); }
      else toast.error(m);
    }
    finally { acting.current = false; }
  };

  const makeFolder = (name: string) => { setPrompt(null); void act(() => sftpMkdir(sid.current, joinRemote(path, name))); };
  const renameEntry = (e: RemoteEntry, name: string) => {
    setPrompt(null);
    if (name !== e.name && entries.some((x) => x.name === name)) { toast.error(`A file or folder named \u201c${name}\u201d already exists here.`); return; }
    void act(() => sftpRename(sid.current, joinRemote(path, e.name), joinRemote(path, name)));
  };
  const makeFile = (name: string) => {
    setPrompt(null);
    if (entries.some((e) => e.name === name)) { toast.error(`A file or folder named \u201c${name}\u201d already exists here.`); return; }
    void act(async () => {
      await sftpWrite(sid.current, joinRemote(path, name), "", null, false);
      setViewing({ entry: { name, kind: "file", link: false, size: 0, mtime: null, mode: null }, dir: path });
    });
  };
  const changeMode = (e: RemoteEntry, mode: number) => {
    setPrompt(null); void act(() => sftpChmod(sid.current, joinRemote(path, e.name), mode), `Permissions updated for \u201c${e.name}\u201d`);
  };
  const osFiles = () => clipboardFiles().then((f) => f ?? []).catch(() => [] as string[]);
  const askMoveConflict = (name: string, many: boolean) => new Promise<MoveChoice>((resolve) => { applyAll.current = false; setMoveConflict({ name, many, answer: resolve }); });
  /** Moves items into `dest`. A taken name asks: replace it (the old one goes to the Trash), keep both, or skip; "for all" remembers it. */
  const moveTo = (names: string[], from: string, dest: string) => act(async () => {
    let remembered: MoveChoice["choice"] | null = null;
    for (let i = 0; i < names.length; i++) {
      const n = names[i], src = joinRemote(from, n), dst = joinRemote(dest, n);
      let policy: "fail" | "replace" | "keep_both" = "fail";
      for (;;) {
        try { await sftpMove(sid.current, src, dst, policy, getFilesPrefs().useTrash); break; }
        catch (e) {
          if (sftpErrorMessage(e) !== SFTP_EXISTS) throw e;
          const c: MoveChoice = remembered ? { choice: remembered, all: true } : await askMoveConflict(n, names.length - i > 1);
          if (c.all) remembered = c.choice;
          if (c.choice === "skip") break;
          policy = c.choice;
        }
      }
    }
  }, `Moved ${names.length === 1 ? `\u201c${names[0]}\u201d` : `${names.length} items`}`);
  /** Cut marks items for moving; paste (in another folder) moves them there. */
  const cut = async (list: RemoteEntry[]) => {
    if (!list.length) return;
    setClip({ dir: pathRef.current, names: list.map((e) => e.name), osSig: (await osFiles()).join("\n") });
  };
  /** Paste: files copied in the system's file explorer are uploaded into `dest`; otherwise items cut here are moved into it. */
  const paste = async (dest: string) => {
    const os = await osFiles();
    if (os.length && os.join("\n") !== clip?.osSig) { void upload(os, dest); return; }
    if (clip && clip.dir !== dest) { const c = clip; setClip(null); void moveTo(c.names, c.dir, dest); return; }
    toast.info(clip ? "Those items are already in this folder." : "Nothing to paste. Copy files in File Explorer, or cut items here first.");
  };

  const onDragStart = (e: DragStartEvent) => {
    const name = (e.active.data.current as EntryDrag).name;
    if (selected.has(name)) setDragNames(picked.map((x) => x.name));
    else { select(name, "single"); setDragNames([name]); }
  };
  const onDragEnd = (e: DragEndEvent) => {
    const names = dragNames;
    setDragNames(null);
    const dest = (e.over?.data.current as EntryDrop | undefined)?.dest;
    if (!names || !dest || dest === pathRef.current) return;
    const movable = names.filter((n) => joinRemote(pathRef.current, n) !== dest);
    if (movable.length) void moveTo(movable, pathRef.current, dest);
  };

  /**
   * Delete: moves the items to the server's Trash (no question: they can be restored), or, with that setting off,
   * deletes them for good after asking.
   */
  const askDelete = (list: RemoteEntry[]) => {
    if (getFilesPrefs().useTrash) trashEntries(list);
    else askDeleteForever(list);
  };
  /** Delete permanently (Shift+Delete, or the menu): asks first, unless the setting says not to. */
  const askDeleteForever = (list: RemoteEntry[]) => { if (getFilesPrefs().confirmDelete) setDeleting(list); else removeEntries(list); };

  const label = (list: RemoteEntry[]) => (list.length === 1 ? `\u201c${list[0].name}\u201d` : `${list.length} items`);
  const refreshTrash = () => sftpTrashList(sid.current).then((l) => setTrashCount(l.length)).catch(() => { toast.warning("Couldn't check the trash. Try again.", { id: "sftp-trash-failed" }); });
  const trashEntries = (list: RemoteEntry[]) => {
    void act(async () => {
      for (const e of list) {
        try { await sftpTrash(sid.current, joinRemote(path, e.name)); }
        catch (err) {
          if (sftpErrorMessage(err) === SFTP_TRASH_FAILED) throw new Error(`This server couldn't move ${label([e])} to the Trash. Use Delete permanently instead.`);
          throw err;
        }
      }
    }, `Moved ${label(list)} to the Trash`).then(() => refreshTrash());
  };
  const removeEntries = (list: RemoteEntry[]) => {
    setDeleting(null);
    void act(async () => { for (const e of list) await sftpRemove(sid.current, joinRemote(path, e.name)); }, `Deleted ${label(list)} permanently`);
  };

  const dropping = useDropTarget({ id: `remote-files-${target.path}-${target.auth}`, element: () => rootEl.current, enabled: ready && active, onDrop: (p) => void upload(p) });

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    if (e.key === "Delete" && picked.length) { e.preventDefault(); if (e.shiftKey) askDeleteForever(picked); else askDelete(picked); }
    else if (e.key === "F2" && picked.length === 1) { e.preventDefault(); setPrompt({ kind: "rename", entry: picked[0] }); }
    else if (e.key === "Enter" && picked.length === 1) { e.preventDefault(); openEntry(picked[0]); }
    else if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); goBack(); }
    else if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); goForward(); }
    else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowUp")) { e.preventDefault(); goUp(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x" && picked.length) { e.preventDefault(); cut(picked); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") { e.preventDefault(); void paste(pathRef.current); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") { e.preventDefault(); setSelected(new Set(shown.map((x) => x.name))); }
  };

  // Why nothing is listed: an empty folder, only dot files that are hidden, or a filter that matches nothing.
  const emptyText = entries.length === 0 ? "This folder is empty."
    : !showHidden && entries.every((e) => e.name.startsWith(".")) && !filter.trim()
      ? "Only hidden (dot) files here. Use the eye button to show them."
      : "Nothing matches the filter.";
  const count = entries.length;
  const status = !ready ? "" : loading ? "Loading…"
    : `${count} item${count === 1 ? "" : "s"}${picked.length ? ` · ${picked.length} selected` : ""}${clip ? ` · ${clip.names.length} cut` : ""}`;

  return (
    <>
      <div ref={rootEl} className="relative flex flex-col h-full min-h-0 bg-[var(--color-bg)] outline-none" tabIndex={-1}
           data-remote-drop="" data-testid="remote-files" aria-label={`Files on ${title}`} onKeyDown={onKey}>
            {phase === "connecting" && <ConnectingNote server={target.title} />}
            {phase === "failed" && <ConnectFailed failure={failure} onRetry={() => void connect()} />}
            {ready && (
              <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragNames(null)}>
                <ConnectionBanner link={link} onReconnect={() => void reconnect()} />
                <RemotePathBar nav={nav} path={path} loading={loading} editingPath={editingPath} onEditingPath={setEditingPath}
                               onBack={goBack} onForward={goForward} onUp={goUp} onRefresh={() => void load(path)} onNavigate={navigate}
                               filter={filter} onFilter={setFilter} onFilterEscape={() => rootEl.current?.focus()}
                               showTrash={showTrash} onToggleTrash={() => setShowTrash((v) => !v)} trashCount={trashCount} />

                <RemoteActionsToolbar picked={picked} pickedFiles={pickedFiles} trashOn={trashOn} showHidden={showHidden} view={view} gridSize={gridSize}
                                      onUpload={() => void chooseUpload()} onUploadFolder={() => void chooseUploadFolder()}
                                      onDownload={() => void download(pickedFiles)}
                                      onNewFolder={() => setPrompt({ kind: "folder" })} onNewFile={() => setPrompt({ kind: "file" })}
                                      onCut={() => void cut(picked)} onPaste={() => void paste(path)}
                                      onRename={() => setPrompt({ kind: "rename", entry: picked[0] })}
                                      onPermissions={() => setPrompt({ kind: "perms", entry: picked[0] })}
                                      onDelete={() => askDelete(picked)} onToggleHidden={() => setShowHidden((v) => !v)}
                                      onView={setView} onSize={setGridSize} onPopOut={onPopOut} />

                {view === "grid" ? (
                  <RemoteFileGrid entries={shown} dir={path} selected={selected} sort={sort} onSort={sortBy} size={gridSize} onZoom={(d) => setGridSize(stepSize(gridSize, d))} onOpen={openEntry} onMenu={openMenu}
                                  onSelect={(n, m) => (n === "" ? setSelected(new Set()) : select(n, m))} empty={emptyText} />
                ) : (
                  <RemoteFileTable entries={shown} dir={path} selected={selected} sort={sort} onSort={sortBy} onSelect={select} onOpen={openEntry} onMenu={openMenu}
                                   empty={emptyText} />
                )}
                <DragOverlay dropAnimation={null}>
                  {dragNames && (
                    <div className="px-2.5 py-1.5 rounded-md text-sm shadow-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text)] whitespace-nowrap">
                      {dragNames.length === 1 ? dragNames[0] : `${dragNames.length} items`}
                    </div>
                  )}
                </DragOverlay>
              </DndContext>
            )}
            <RemoteTransfers items={transfers}
                             onCancel={(id) => void sftpCancel(id)}
                             onClear={clearFinished} />
            {showTrash && <RemoteTrashSheet session={sid.current} server={title} onClose={() => setShowTrash(false)} onChanged={() => void load(pathRef.current)} onCount={setTrashCount} />}
            {viewing && (
              <RemoteFileViewer session={sid.current} path={joinRemote(viewing.dir, viewing.entry.name)} name={viewing.entry.name}
                                onClose={() => setViewing(null)} onDownload={() => void download([viewing.entry])}
                                onSaved={() => void load(pathRef.current)} />
            )}
            {dropping && <DropHighlight icon={<Upload size={16} />}>Drop files or folders to upload to {path}</DropHighlight>}
        <div className="shrink-0 flex items-center h-7 px-3 border-t border-[var(--color-border)] text-xs text-[var(--color-text-muted)]" role="status">
          {status || `Files on ${title}`}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={remoteMenuItems(menu.entry, {
        path, selected, picked, trashOn, chooseUpload, chooseUploadFolder, setPrompt, paste, load, copy, setShowTrash, openEntry, download, cut,
        askDelete, askDeleteForever,
      })} onClose={() => setMenu(null)} label={menu.entry ? `Actions for ${menu.entry.name}` : "Folder actions"} />}
      {prompt?.kind === "folder" && (
        <NameDialog title="New folder" label="Folder name" initial="" confirm="Create" onSubmit={makeFolder} onClose={() => setPrompt(null)} />
      )}
      {prompt?.kind === "file" && (
        <NameDialog title="New file" label="File name" initial="" confirm="Create" onSubmit={makeFile} onClose={() => setPrompt(null)} />
      )}
      {prompt?.kind === "perms" && (
        <PermissionsDialog name={prompt.entry.name} mode={prompt.entry.mode} onApply={(m) => changeMode(prompt.entry, m)} onClose={() => setPrompt(null)} />
      )}
      {prompt?.kind === "rename" && (
        <NameDialog title="Rename" label="New name" initial={prompt.entry.name} confirm="Rename"
                    onSubmit={(n) => renameEntry(prompt.entry, n)} onClose={() => setPrompt(null)} />
      )}
      {deleting && (
        <ConfirmDialog title={deleteTitle(deleting)} message={deleteMessage(deleting, title)}
                       detail={`Location: ${path}`} icon="danger" danger confirmLabel="Delete permanently"
                       onConfirm={() => removeEntries(deleting)} onCancel={() => setDeleting(null)} />
      )}
      {replace && <ReplaceDialog replace={replace} onDone={() => setReplace(null)} />}
      {moveConflict && <MoveConflictDialog moveConflict={moveConflict} applyAll={applyAll} onDone={() => setMoveConflict(null)} />}
    </>
  );
}
