import { ClipboardPaste, Download, Eye, EyeOff, FilePlus, FileX, FolderPlus, FolderUp, Pencil, Scissors, ShieldCheck, SquareArrowOutUpRight, Trash2, Upload } from "lucide-react";
import { RowIconButton } from "../../vault/ListEditor";
import { ViewSwitcher } from "../ViewSwitcher";
import type { FilesView, GridSize } from "../../../lib/filesPrefs";
import type { RemoteEntry } from "../../../lib/sftp";

/** The "File actions" toolbar: upload / download, new, cut / paste, rename / permissions / delete, and view options. */
export function RemoteActionsToolbar({
  picked, pickedFiles, trashOn, showHidden, view, gridSize, onUpload, onUploadFolder, onDownload, onNewFolder, onNewFile,
  onCut, onPaste, onRename, onPermissions, onDelete, onToggleHidden, onView, onSize, onPopOut,
}: {
  picked: RemoteEntry[];
  pickedFiles: RemoteEntry[];
  trashOn: boolean;
  showHidden: boolean;
  view: FilesView;
  gridSize: GridSize;
  onUpload: () => void;
  onUploadFolder: () => void;
  onDownload: () => void;
  onNewFolder: () => void;
  onNewFile: () => void;
  onCut: () => void;
  onPaste: () => void;
  onRename: () => void;
  onPermissions: () => void;
  onDelete: () => void;
  onToggleHidden: () => void;
  onView: (v: FilesView) => void;
  onSize: (v: GridSize) => void;
  onPopOut?: () => void;
}) {
  return (
    <div className="flex items-center gap-0.5 px-3 py-1.5 border-b border-[var(--color-border)]" role="toolbar" aria-label="File actions">
      <RowIconButton label="Upload" tooltip="Upload files (or drag and drop them here)" icon={<Upload size={15} />} onClick={onUpload} />
      <RowIconButton label="Upload folder" tooltip="Upload a folder (or drag one here)" icon={<FolderUp size={15} />} onClick={onUploadFolder} />
      <RowIconButton label="Download" tooltip={pickedFiles.length > 1 ? `Download ${pickedFiles.length} items` : "Download (files and folders)"} icon={<Download size={15} />}
                     disabled={pickedFiles.length === 0} onClick={onDownload} />
      <span className="w-px h-5 mx-1.5 bg-[var(--color-border)]" aria-hidden />
      <RowIconButton label="New folder" icon={<FolderPlus size={15} />} onClick={onNewFolder} />
      <RowIconButton label="New file" icon={<FilePlus size={15} />} onClick={onNewFile} />
      <span className="w-px h-5 mx-1.5 bg-[var(--color-border)]" aria-hidden />
      <RowIconButton label="Cut" tooltip="Cut (Ctrl+X): then open a folder and paste" icon={<Scissors size={15} />} disabled={picked.length === 0} onClick={onCut} />
      <RowIconButton label="Paste" tooltip="Paste (Ctrl+V): uploads files copied in File Explorer, or moves the items you cut"
                     icon={<ClipboardPaste size={15} />} onClick={onPaste} />
      <span className="w-px h-5 mx-1.5 bg-[var(--color-border)]" aria-hidden />
      <RowIconButton label="Rename" tooltip="Rename (F2)" icon={<Pencil size={15} />} disabled={picked.length !== 1} onClick={onRename} />
      <RowIconButton label="Permissions" icon={<ShieldCheck size={15} />} disabled={picked.length !== 1} onClick={onPermissions} />
      <RowIconButton label="Delete" tooltip={trashOn ? "Move to Trash (Del)" : "Delete permanently (Del)"} icon={trashOn ? <Trash2 size={15} /> : <FileX size={15} />} danger disabled={picked.length === 0} onClick={onDelete} />
      <span className="ml-auto mr-2 hidden lg:flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]" aria-hidden>
        <Upload size={12} />Drag files or folders here to upload
      </span>
      <span className="w-px h-5 mx-1.5 bg-[var(--color-border)] max-lg:ml-auto" aria-hidden />
      <RowIconButton label={showHidden ? "Hide dot files" : "Show dot files"} icon={showHidden ? <Eye size={15} /> : <EyeOff size={15} />}
                     pressed={showHidden} onClick={onToggleHidden} />
      <ViewSwitcher view={view} size={gridSize} onView={onView} onSize={onSize} />
      {onPopOut && <RowIconButton label="Open in new window" icon={<SquareArrowOutUpRight size={15} />} onClick={onPopOut} />}
    </div>
  );
}
