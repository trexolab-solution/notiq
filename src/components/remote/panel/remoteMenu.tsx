import {
  Archive, ArchiveRestore, ClipboardPaste, Copy, Download, FilePenLine, FilePlus, FileX, FolderOpen, FolderPlus, FolderUp, Pencil,
  Info, RefreshCw, Scissors, ShieldCheck, Trash2, Upload,
} from "lucide-react";
import type { ContextMenuItem } from "../../ui/ContextMenu";
import { archiveNeeds, archiveStem, isArchiveName, joinRemote, type ArchiveTools, type RemoteEntry } from "../../../lib/sftp";
import type { Prompt } from "./types";

/** What the right-click menu acts with. */
export interface RemoteMenuActions {
  path: string;
  selected: ReadonlySet<string>;
  picked: RemoteEntry[];
  trashOn: boolean;
  chooseUpload: () => Promise<void>;
  chooseUploadFolder: () => Promise<void>;
  setPrompt: (p: Prompt) => void;
  paste: (dest: string) => Promise<void>;
  load: (path: string) => Promise<void>;
  copy: (text: string) => unknown;
  setShowTrash: (v: boolean) => void;
  openEntry: (e: RemoteEntry) => void;
  download: (items: RemoteEntry[]) => Promise<void>;
  cut: (list: RemoteEntry[]) => unknown;
  askDelete: (list: RemoteEntry[]) => void;
  askDeleteForever: (list: RemoteEntry[]) => void;
  /** Opens Properties for these items (the open folder itself when given its own path and no entry). */
  showProperties: (items: { path: string; entry?: RemoteEntry }[]) => void;
  /** What the server can compress / extract with (null until known). */
  tools: ArchiveTools | null;
  compress: (list: RemoteEntry[]) => void;
  extractHere: (e: RemoteEntry) => void;
  extractToFolder: (e: RemoteEntry) => void;
}

/** Joins groups of items with one separator between them; empty groups are skipped. */
const groups = (...g: ContextMenuItem[][]): ContextMenuItem[] =>
  g.filter((x) => x.length > 0).flatMap((x, i) => (i ? [{ type: "separator" as const }, ...x] : x));

/**
 * The right-click menu. On a row (or the selection it is part of) it holds only what can be done to those items, in
 * groups: open and download; cut, rename, copy path; compress and extract; properties and permissions; delete.
 * On empty space it holds the folder's own actions: new, upload, paste, refresh and copy path, properties, Trash.
 * Nothing appears in both.
 */
export function remoteMenuItems(entry: RemoteEntry | null, a: RemoteMenuActions): ContextMenuItem[] {
  const { path, selected, picked, trashOn } = a;

  if (!entry) {
    return groups(
      [
        { type: "item", label: "New folder…", icon: <FolderPlus size={13} />, onClick: () => a.setPrompt({ kind: "folder" }) },
        { type: "item", label: "New file…", icon: <FilePlus size={13} />, onClick: () => a.setPrompt({ kind: "file" }) },
      ],
      [
        { type: "item", label: "Upload files…", icon: <Upload size={13} />, onClick: () => void a.chooseUpload() },
        { type: "item", label: "Upload folder…", icon: <FolderUp size={13} />, onClick: () => void a.chooseUploadFolder() },
      ],
      [{ type: "item", label: "Paste", icon: <ClipboardPaste size={13} />, shortcut: "Ctrl+V", onClick: () => void a.paste(path) }],
      [
        { type: "item", label: "Refresh", icon: <RefreshCw size={13} />, onClick: () => void a.load(path) },
        { type: "item", label: "Copy folder path", icon: <Copy size={13} />, onClick: () => void a.copy(path) },
      ],
      [{ type: "item", label: "Properties", icon: <Info size={13} />, onClick: () => a.showProperties([{ path }]) }],
      [{ type: "item", label: "Open Trash", icon: <ArchiveRestore size={13} />, onClick: () => a.setShowTrash(true) }],
    );
  }

  // The menu acts on the whole selection when the clicked row is part of it.
  const group = selected.has(entry.name) && picked.length > 1 ? picked : [entry];
  const files = group.filter((e) => e.kind !== "other");
  const one = group.length === 1;
  const folder = one && entry.kind === "dir";
  return groups(
    [
      folder
        ? { type: "item", label: "Open", icon: <FolderOpen size={13} />, onClick: () => a.openEntry(entry) }
        : { type: "item", label: "Open / edit", icon: <FilePenLine size={13} />, disabled: !one || entry.kind !== "file", onClick: () => a.openEntry(entry) },
      { type: "item", label: files.length > 1 ? `Download ${files.length} items…` : "Download…", icon: <Download size={13} />, disabled: files.length === 0, onClick: () => void a.download(files) },
    ],
    [
      { type: "item", label: "Cut", icon: <Scissors size={13} />, shortcut: "Ctrl+X", onClick: () => a.cut(group) },
      ...(folder ? [{ type: "item" as const, label: "Paste into folder", icon: <ClipboardPaste size={13} />, onClick: () => void a.paste(joinRemote(path, entry.name)) }] : []),
      { type: "item", label: "Rename…", icon: <Pencil size={13} />, shortcut: "F2", disabled: !one, onClick: () => a.setPrompt({ kind: "rename", entry }) },
      { type: "item", label: "Copy path", icon: <Copy size={13} />, disabled: !one, onClick: () => void a.copy(joinRemote(path, entry.name)) },
    ],
    archiveItems(entry, group, a),
    [
      { type: "item", label: "Properties", icon: <Info size={13} />, shortcut: "Alt+Enter", onClick: () => a.showProperties(group.map((e) => ({ path: joinRemote(path, e.name), entry: e }))) },
      { type: "item", label: "Permissions…", icon: <ShieldCheck size={13} />, disabled: !one, onClick: () => a.setPrompt({ kind: "perms", entry }) },
    ],
    [
      { type: "item", label: trashOn ? "Move to Trash" : (one ? "Delete…" : `Delete ${group.length} items…`), icon: trashOn ? <Trash2 size={13} /> : <FileX size={13} />, shortcut: "Del", danger: true, onClick: () => a.askDelete(group) },
      ...(trashOn ? [{ type: "item" as const, label: "Delete permanently…", icon: <FileX size={13} />, shortcut: "Shift+Del", danger: true, onClick: () => a.askDeleteForever(group) }] : []),
    ],
  );
}

/** Compress (any selection) and Extract (a single archive file): enabled by the tools the server has. */
function archiveItems(entry: RemoteEntry, group: RemoteEntry[], a: RemoteMenuActions): ContextMenuItem[] {
  const canCompress = !!a.tools && (a.tools.zip || a.tools.tar);
  const items: ContextMenuItem[] = [
    { type: "item", label: group.length > 1 ? `Compress ${group.length} items…` : "Compress…", icon: <Archive size={13} />, disabled: !canCompress, onClick: () => a.compress(group) },
  ];
  if (group.length === 1 && entry.kind === "file" && isArchiveName(entry.name)) {
    const can = !!a.tools && (archiveNeeds(entry.name) === "unzip" ? a.tools.unzip : a.tools.tar);
    items.push(
      { type: "item", label: "Extract here", icon: <ArchiveRestore size={13} />, disabled: !can, onClick: () => a.extractHere(entry) },
      { type: "item", label: `Extract to \u201c${archiveStem(entry.name)}/\u201d`, icon: <ArchiveRestore size={13} />, disabled: !can, onClick: () => a.extractToFolder(entry) },
    );
  }
  return items;
}
