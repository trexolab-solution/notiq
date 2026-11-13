import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { open as pickFiles, save as pickSave } from "@tauri-apps/plugin-dialog";
import {
  Archive, ArchiveRestore, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Copy, Download, Eye, EyeOff, FilePenLine, FilePlus, FileX, FolderUp, FolderOpen, FolderPlus, Pencil,
  RefreshCw, Scissors, Search, ShieldCheck, SquareArrowOutUpRight, Trash2, Upload,
} from "lucide-react";
import { DndContext, DragOverlay, PointerSensor, pointerWithin, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { Dialog, DialogBody, DialogButton, DialogFooter } from "../ui/Dialog";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Input } from "../ui/Input";
import { DropHighlight, useDropTarget } from "../ui/DropZone";
import { RowIconButton } from "../vault/ListEditor";
import { RemoteFileTable } from "./RemoteFileTable";
import { RemoteFileGrid } from "./RemoteFileGrid";
import { ViewSwitcher, stepSize } from "./ViewSwitcher";
import { RemoteFileViewer } from "./RemoteFileViewer";
import { PermissionsDialog } from "./PermissionsDialog";
import { RemoteTrashSheet } from "./RemoteTrashSheet";
import type { EntryDrag, EntryDrop } from "./useEntryDnd";
import { RemoteTransfers, type Transfer } from "./RemoteTransfers";
import { toast } from "../../lib/toast";
import { getFilesPrefs, setFilesPrefs, type FilesView, type GridSize } from "../../lib/filesPrefs";
import { getFileName, joinPath } from "../../lib/pathUtils";
import type { SshTarget } from "../../lib/sshConnect";
import {
  clipboardFiles, crumbs, joinRemote, nameProblem, onSftpProgress, parentRemote, sftpCancel, sftpClose, sftpDownload, sftpErrorMessage,
  sftpChmod, sftpList, sftpMkdir, sftpMove, sftpOpen, sftpRemove, sftpRename, sftpTrash, sftpTrashList, sftpUpload, sftpWrite, sortEntries, visibleEntries, isConnectionError, SFTP_CANCELLED, SFTP_EXISTS, SFTP_EXISTS_DIR, SFTP_TRASH_FAILED,
  type MergeMode, type RemoteEntry, type SortKey, type SortState,
} from "../../lib/sftp";

// Session and transfer ids are shared by every window (the backend keeps them in one table), so each window starts
// from its own range: two file managers must never share an id.
const idBase = (Date.now() % 1_000_000) * 1000;
let nextSession = idBase + 1;
let nextTransfer = idBase + 1;

type Phase = "connecting" | "ready" | "failed";
/** The answer to "this name is already taken": replace it, (for folders) keep the files that are already there, or stop. */
type Conflict = "replace" | "skip-matching" | "cancel";
type MoveChoice = { choice: "replace" | "keep_both" | "skip"; all: boolean };
type Prompt = { kind: "folder" } | { kind: "file" } | { kind: "rename"; entry: RemoteEntry } | { kind: "perms"; entry: RemoteEntry };

/** One part of the path bar: click to go there; an item dragged onto it is moved into that folder. */
function Crumb({ c, last, onGo }: { c: { name: string; path: string }; last: boolean; onGo: (path: string) => void }) {
  const drop = useDroppable({ id: `crumb:${c.path}`, data: { dest: c.path } satisfies EntryDrop });
  return (
    <button ref={drop.setNodeRef} type="button" onClick={() => onGo(c.path)}
            className={`px-1.5 py-0.5 rounded text-sm cursor-pointer ${drop.isOver ? "bg-[var(--color-primary)]/25 ring-1 ring-[var(--color-primary)] text-[var(--color-text)]"
              : `hover:bg-[var(--color-bg-tertiary)] ${last ? "font-medium text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}`}>
      {c.name}
    </button>
  );
}

/** "Delete folder “x”?", "Delete file “x”?" or "Delete 3 items?". */
export function deleteTitle(list: RemoteEntry[]): string {
  if (list.length > 1) return `Delete ${list.length} items?`;
  return `Delete ${list[0].kind === "dir" ? "folder" : "file"} \u201c${list[0].name}\u201d?`;
}

/** What deleting will do, in plain words: permanent (a server has no Recycle Bin), and folders take their contents along. */
export function deleteMessage(list: RemoteEntry[], server: string): string {
  const folders = list.filter((e) => e.kind === "dir").length;
  if (list.length === 1) {
    return folders
      ? `The folder and everything inside it will be permanently deleted from ${server}. This can't be undone.`
      : `The file will be permanently deleted from ${server}. This can't be undone.`;
  }
  return folders
    ? `These items will be permanently deleted from ${server}, including everything inside the folders. This can't be undone.`
    : `These files will be permanently deleted from ${server}. This can't be undone.`;
}

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
  const [sort, setSort] = useState<SortState>(() => { const p = getFilesPrefs(); return { key: p.sortKey, desc: p.sortDesc }; });
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(() => getFilesPrefs().showHidden);
  const [view, setViewState] = useState<FilesView>(() => getFilesPrefs().view);
  const [gridSize, setGridSizeState] = useState<GridSize>(() => getFilesPrefs().gridSize);
  // The layout is remembered: the last one picked here is what the next file manager opens with.
  const setView = (v: FilesView) => { setViewState(v); setFilesPrefs({ view: v }); };
  const setGridSize = (v: GridSize) => { setGridSizeState(v); setFilesPrefs({ gridSize: v }); };
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [deleting, setDeleting] = useState<RemoteEntry[] | null>(null);
  const [replace, setReplace] = useState<{ name: string; folder: boolean; answer: (c: Conflict) => void } | null>(null);
  const [moveConflict, setMoveConflict] = useState<{ name: string; many: boolean; answer: (c: MoveChoice) => void } | null>(null);
  const applyAll = useRef(false);
  /** The connection to the server: fine, being re-established after it dropped, or lost for good (a button retries). */
  const [link, setLink] = useState<"ok" | "reconnecting" | "lost">("ok");
  const alive = useRef(true);
  const reconnecting = useRef(false);
  const reconnectRef = useRef<() => void>(() => {});
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: RemoteEntry | null } | null>(null);
  /** The file open in the viewer, with the folder it is in. */
  const [viewing, setViewing] = useState<{ entry: RemoteEntry; dir: string } | null>(null);
  const { copy } = useCopyToClipboard();
  /** Folders visited before and after this one (back / forward), like a browser. */
  const [nav, setNav] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] });
  /** Items cut for moving: where they are and their names. */
  const [clip, setClip] = useState<{ dir: string; names: string[]; /** What the system clipboard held when these were cut. */ osSig: string } | null>(null);
  /** The items being dragged (to move them into a folder). */
  const [showTrash, setShowTrash] = useState(false);
  /** Items in the server's Trash (null until known): the Trash button shows empty / not empty. */
  const [trashCount, setTrashCount] = useState<number | null>(null);
  const [dragNames, setDragNames] = useState<string[] | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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
      if (session === sid.current) {
        const m = sftpErrorMessage(e);
        if (isConnectionError(m)) reconnectRef.current(); else toast.error(m);
      }
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
      setNav({ back: [], fwd: [] });
      void sftpTrashList(session).then((l) => { if (session === sid.current) setTrashCount(l.length); }).catch(() => {});
      await load(o.home, session);
    } catch (e) {
      if (session !== sid.current) return;
      setFailure(sftpErrorMessage(e)); setPhase("failed");
    }
  }, [target, load]);

  /** Signs in again after the connection dropped (up to three tries), then shows the same folder again. */
  const reconnect = useCallback(async () => {
    if (reconnecting.current || !alive.current) return;
    reconnecting.current = true;
    setLink("reconnecting");
    if (sid.current) void sftpClose(sid.current);
    for (const wait of [0, 1500, 4000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      if (!alive.current) { reconnecting.current = false; return; }
      const session = nextSession++;
      sid.current = session;
      try {
        await sftpOpen(session, target.path, target.auth);
        if (!alive.current || session !== sid.current) { void sftpClose(session); reconnecting.current = false; return; }
        reconnecting.current = false;
        setLink("ok");
        await load(pathRef.current || ".", session);
        void sftpTrashList(session).then((l) => { if (session === sid.current) setTrashCount(l.length); }).catch(() => {});
        return;
      } catch { /* try again, or give up below */ }
    }
    reconnecting.current = false;
    if (alive.current) setLink("lost");
  }, [target, load]);
  reconnectRef.current = () => void reconnect();

  // Coming back to the window (or to this tab) after a while: find out quietly whether the connection survived.
  useEffect(() => {
    if (phase !== "ready" || !active) return;
    let last = 0;
    const probe = () => {
      if (link !== "ok" || Date.now() - last < 10_000) return;
      last = Date.now();
      sftpList(sid.current, pathRef.current || ".").catch((e) => { if (isConnectionError(sftpErrorMessage(e))) reconnectRef.current(); });
    };
    window.addEventListener("focus", probe);
    return () => window.removeEventListener("focus", probe);
  }, [phase, active, link]);

  useEffect(() => {
    alive.current = true;
    void connect();
    return () => {
        alive.current = false; const s = sid.current; sid.current = 0; if (s) void sftpClose(s); };
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

  // ── transfers ────────────────────────────────────────────────────────────────

  const track = (t: Transfer) => setTransfers((ts) => [...ts, t]);
  const finish = (id: number, patch: Partial<Transfer>) => setTransfers((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const askReplace = (name: string, folder: boolean) => new Promise<Conflict>((resolve) => setReplace({ name, folder, answer: resolve }));

  type Run = (id: number, overwrite: boolean, merge?: MergeMode) => Promise<number>;
  /**
   * One transfer: runs it; when the target exists asks what to do (replace; for a folder also keep the files that are
   * already there), then runs it again. A lost connection starts the reconnect.
   */
  const runTransfer = async (kind: "up" | "down", name: string, run: Run) => {
    const id = nextTransfer++;
    track({ id, kind, name, done: 0, total: 0, state: "running" });
    const fail = (e: unknown) => {
      const m = sftpErrorMessage(e);
      if (m === SFTP_CANCELLED) { finish(id, { state: "cancelled" }); return; }
      finish(id, { state: "error", error: m });
      if (isConnectionError(m)) reconnectRef.current();
    };
    try {
      await run(id, false);
      finish(id, { state: "done" });
    } catch (e) {
      const msg = sftpErrorMessage(e);
      if (msg === SFTP_EXISTS || msg === SFTP_EXISTS_DIR) {
        const c = await askReplace(name, msg === SFTP_EXISTS_DIR);
        if (c === "cancel") { finish(id, { state: "skipped" }); return; }
        try { await run(id, true, c === "skip-matching" ? "skip" : "replace"); finish(id, { state: "done" }); }
        catch (e2) { fail(e2); }
        return;
      }
      fail(e);
    }
  };

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

  const menuItems = (entry: RemoteEntry | null): ContextMenuItem[] => {
    const here: ContextMenuItem[] = [
      { type: "item", label: "Upload files here\u2026", icon: <Upload size={13} />, onClick: () => void chooseUpload() },
      { type: "item", label: "Upload folder here\u2026", icon: <FolderUp size={13} />, onClick: () => void chooseUploadFolder() },
      { type: "item", label: "New folder\u2026", icon: <FolderPlus size={13} />, onClick: () => setPrompt({ kind: "folder" }) },
      { type: "item", label: "New file\u2026", icon: <FilePlus size={13} />, onClick: () => setPrompt({ kind: "file" }) },
      { type: "item", label: "Paste here", icon: <ClipboardPaste size={13} />, shortcut: "Ctrl+V", onClick: () => void paste(path) },
      { type: "item", label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void load(path) },
      { type: "item", label: "Copy folder path", icon: <Copy size={13} />, onClick: () => void copy(path) },
      { type: "separator" },
      { type: "item", label: "Open Trash", icon: <ArchiveRestore size={13} />, onClick: () => setShowTrash(true) },
    ];
    if (!entry) return here;
    // The menu acts on the whole selection when the clicked row is part of it.
    const group = selected.has(entry.name) && picked.length > 1 ? picked : [entry];
    const files = group.filter((e) => e.kind !== "other");
    const one = group.length === 1;
    return [
      one && entry.kind === "dir"
        ? { type: "item", label: "Open", icon: <FolderOpen size={13} />, onClick: () => openEntry(entry) }
        : { type: "item", label: "Open / edit", icon: <FilePenLine size={13} />, disabled: !one || entry.kind !== "file", onClick: () => openEntry(entry) },
      { type: "item", label: files.length > 1 ? `Download ${files.length} items\u2026` : "Download\u2026", icon: <Download size={13} />, disabled: files.length === 0, onClick: () => void download(files) },
      { type: "separator" },
      { type: "item", label: "Cut", icon: <Scissors size={13} />, shortcut: "Ctrl+X", onClick: () => cut(group) },
      ...(one && entry.kind === "dir" ? [{ type: "item" as const, label: "Paste into folder", icon: <ClipboardPaste size={13} />, onClick: () => void paste(joinRemote(path, entry.name)) }] : []),
      { type: "item", label: "Rename\u2026", icon: <Pencil size={13} />, shortcut: "F2", disabled: !one, onClick: () => setPrompt({ kind: "rename", entry }) },
      { type: "item", label: "Permissions\u2026", icon: <ShieldCheck size={13} />, disabled: !one, onClick: () => setPrompt({ kind: "perms", entry }) },
      { type: "item", label: "Copy path", icon: <Copy size={13} />, disabled: !one, onClick: () => void copy(joinRemote(path, entry.name)) },
      { type: "separator" },
      { type: "item", label: trashOn ? "Move to Trash" : (one ? "Delete\u2026" : `Delete ${group.length} items\u2026`), icon: trashOn ? <Trash2 size={13} /> : <FileX size={13} />, shortcut: "Del", danger: true, onClick: () => askDelete(group) },
      ...(trashOn ? [{ type: "item" as const, label: "Delete permanently\u2026", icon: <FileX size={13} />, shortcut: "Shift+Del", danger: true, onClick: () => askDeleteForever(group) }] : []),
      { type: "separator" },
      ...here,
    ];
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
  const refreshTrash = () => sftpTrashList(sid.current).then((l) => setTrashCount(l.length)).catch(() => {});
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
              <DndContext sensors={sensors} collisionDetection={pointerWithin} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragNames(null)}>
                {link !== "ok" && (
                  <div role="status" className="flex items-center gap-2 px-3 h-9 shrink-0 text-sm border-b border-[var(--color-border)] bg-[var(--color-warning,#d97706)]/15">
                    <span className="flex-1 min-w-0 truncate">
                      {link === "reconnecting" ? "Connection lost. Reconnecting\u2026" : "Connection lost. Your changes and transfers can't continue until it is back."}
                    </span>
                    {link === "lost" && <DialogButton variant="primary" icon={<RefreshCw size={13} />} onClick={() => void reconnect()}>Reconnect</DialogButton>}
                  </div>
                )}
                <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--color-border)]">
                  <RowIconButton label="Back" tooltip="Back (Alt+Left)" icon={<ArrowLeft size={14} />} disabled={nav.back.length === 0} onClick={goBack} />
                  <RowIconButton label="Forward" tooltip="Forward (Alt+Right)" icon={<ArrowRight size={14} />} disabled={nav.fwd.length === 0} onClick={goForward} />
                  <RowIconButton label="Up one folder" tooltip="Up (Backspace)" icon={<ArrowUp size={14} />} disabled={path === "/"} onClick={goUp} />
                  <RowIconButton label="Refresh" icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />} onClick={() => void load(path)} />
                  {editingPath === null ? (
                    <nav aria-label="Folder path" className="flex-1 min-w-0 flex items-center overflow-x-auto h-8 rounded-md px-1.5 border border-[var(--color-border)] bg-[var(--color-bg-secondary)] cursor-text"
                         onDoubleClick={() => setEditingPath(path)}>
                      {crumbs(path).map((c, i, all) => (
                        <span key={c.path} className="flex items-center shrink-0">
                          <Crumb c={c} last={i === all.length - 1} onGo={navigate} />
                          {i > 0 && i < all.length - 1 && <span className="text-[var(--color-text-muted)]" aria-hidden>/</span>}
                        </span>
                      ))}
                    </nav>
                  ) : (
                    <Input className="flex-1 min-w-0 font-mono" value={editingPath} autoFocus spellCheck={false} aria-label="Folder path"
                           onChange={(e) => setEditingPath(e.target.value)} onFocus={(e) => e.currentTarget.select()}
                           onBlur={() => setEditingPath(null)}
                           onKeyDown={(e) => {
                             if (e.key === "Enter") { const p = editingPath.trim(); setEditingPath(null); if (p) navigate(p); }
                             if (e.key === "Escape") { e.stopPropagation(); setEditingPath(null); }
                           }} />
                  )}
                  <div className="relative w-44 shrink-0">
                    <Search size={13} aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
                    <Input className="!pl-7" value={filter} placeholder="Filter" aria-label="Filter files" spellCheck={false}
                           onChange={(e) => setFilter(e.target.value)} />
                  </div>
                  <span className="relative inline-flex">
                    <RowIconButton label="Trash" pressed={showTrash} onClick={() => setShowTrash((v) => !v)}
                                   tooltip={trashCount ? `Trash: ${trashCount} item${trashCount === 1 ? "" : "s"}. Restore or empty` : "Trash is empty"}
                                   icon={trashCount ? <ArchiveRestore size={15} className="text-[var(--color-warning,#d97706)]" /> : <Archive size={15} />} />
                    {!!trashCount && (
                      <span aria-hidden className="pointer-events-none absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 grid place-items-center rounded-full text-[9px] font-semibold leading-none bg-[var(--color-warning,#d97706)] text-[var(--color-bg)]">
                        {trashCount > 99 ? "99+" : trashCount}
                      </span>
                    )}
                  </span>
                </div>

                <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[var(--color-border)]" role="toolbar" aria-label="File actions">
                  <RowIconButton label="Upload" tooltip="Upload files (or drag and drop them here)" icon={<Upload size={15} />} onClick={() => void chooseUpload()} />
                  <RowIconButton label="Upload folder" tooltip="Upload a folder (or drag one here)" icon={<FolderUp size={15} />} onClick={() => void chooseUploadFolder()} />
                  <RowIconButton label="Download" tooltip={pickedFiles.length > 1 ? `Download ${pickedFiles.length} items` : "Download (files and folders)"} icon={<Download size={15} />}
                                 disabled={pickedFiles.length === 0} onClick={() => void download(pickedFiles)} />
                  <span className="w-px h-5 mx-1.5 bg-[var(--color-border)]" aria-hidden />
                  <RowIconButton label="New folder" icon={<FolderPlus size={15} />} onClick={() => setPrompt({ kind: "folder" })} />
                  <RowIconButton label="New file" icon={<FilePlus size={15} />} onClick={() => setPrompt({ kind: "file" })} />
                  <span className="w-px h-5 mx-1.5 bg-[var(--color-border)]" aria-hidden />
                  <RowIconButton label="Cut" tooltip="Cut (Ctrl+X): then open a folder and paste" icon={<Scissors size={15} />} disabled={picked.length === 0} onClick={() => void cut(picked)} />
                  <RowIconButton label="Paste" tooltip="Paste (Ctrl+V): uploads files copied in File Explorer, or moves the items you cut"
                                 icon={<ClipboardPaste size={15} />} onClick={() => void paste(path)} />
                  <span className="w-px h-5 mx-1.5 bg-[var(--color-border)]" aria-hidden />
                  <RowIconButton label="Rename" tooltip="Rename (F2)" icon={<Pencil size={15} />} disabled={picked.length !== 1} onClick={() => setPrompt({ kind: "rename", entry: picked[0] })} />
                  <RowIconButton label="Permissions" icon={<ShieldCheck size={15} />} disabled={picked.length !== 1} onClick={() => setPrompt({ kind: "perms", entry: picked[0] })} />
                  <RowIconButton label="Delete" tooltip={trashOn ? "Move to Trash (Del)" : "Delete permanently (Del)"} icon={trashOn ? <Trash2 size={15} /> : <FileX size={15} />} danger disabled={picked.length === 0} onClick={() => askDelete(picked)} />
                  <span className="ml-auto mr-2 hidden lg:flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]" aria-hidden>
                    <Upload size={12} />Drag files or folders here to upload
                  </span>
                  <span className="w-px h-5 mx-1.5 bg-[var(--color-border)] max-lg:ml-auto" aria-hidden />
                  <RowIconButton label={showHidden ? "Hide dot files" : "Show dot files"} icon={showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
                                 pressed={showHidden} onClick={() => setShowHidden((v) => !v)} />
                  <ViewSwitcher view={view} size={gridSize} onView={setView} onSize={setGridSize} />
                  {onPopOut && <RowIconButton label="Open in new window" icon={<SquareArrowOutUpRight size={15} />} onClick={onPopOut} />}
                </div>

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
                             onClear={() => setTransfers((ts) => ts.filter((t) => t.state === "running"))} />
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

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.entry)} onClose={() => setMenu(null)} label={menu.entry ? `Actions for ${menu.entry.name}` : "Folder actions"} />}
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
      {replace && (replace.folder ? (
        <ConfirmDialog title={`Merge into the existing folder \u201c${replace.name}\u201d?`}
                       message={`A folder named \u201c${replace.name}\u201d is already in the destination. Files that are only in one of them stay as they are. What should happen to files that have the same name in both?`}
                       confirmLabel="Replace matching files" discardLabel="Skip matching files" cancelLabel="Cancel" danger
                       onConfirm={() => { replace.answer("replace"); setReplace(null); }}
                       onDiscard={() => { replace.answer("skip-matching"); setReplace(null); }}
                       onCancel={() => { replace.answer("cancel"); setReplace(null); }} />
      ) : (
        <ConfirmDialog title={`Replace \u201c${replace.name}\u201d?`}
                       message={`A file named \u201c${replace.name}\u201d already exists in this folder. Replacing it overwrites the existing file.`}
                       confirmLabel="Replace" cancelLabel="Keep existing" danger
                       onConfirm={() => { replace.answer("replace"); setReplace(null); }}
                       onCancel={() => { replace.answer("cancel"); setReplace(null); }} />
      ))}
      {moveConflict && (
        <ConfirmDialog title={`\u201c${moveConflict.name}\u201d already exists there`}
                       message={`An item named \u201c${moveConflict.name}\u201d is already in the destination folder. Replace it${getFilesPrefs().useTrash ? " (the existing one goes to the Trash)" : " (the existing one is deleted)"}, keep both (this one is renamed), or skip it?`}
                       confirmLabel="Replace" discardLabel="Keep both" cancelLabel="Skip" danger
                       checkbox={moveConflict.many ? { label: "Do this for all the other conflicts", onChange: (v) => { applyAll.current = v; } } : undefined}
                       onConfirm={() => { moveConflict.answer({ choice: "replace", all: applyAll.current }); setMoveConflict(null); }}
                       onDiscard={() => { moveConflict.answer({ choice: "keep_both", all: applyAll.current }); setMoveConflict(null); }}
                       onCancel={() => { moveConflict.answer({ choice: "skip", all: applyAll.current }); setMoveConflict(null); }} />
      )}
    </>
  );
}
