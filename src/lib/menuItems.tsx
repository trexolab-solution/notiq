import {
  FileDown, FilePlus, Files, FolderOpen, Save, SaveAll, SquarePen, Trash2,
} from "lucide-react";
import type { ContextMenuItem } from "../components/ui/ContextMenu";

export interface FileMenuContext {
  addTab: () => void;
  onNewWhiteboard: () => void;
  onOpenMultiple: () => void;
  onOpenFolder: () => void;
  saveTabToFile: (id: string) => Promise<boolean>;
  saveTabToFileAs: (id: string) => Promise<boolean>;
  exportPDF: () => void;
  requestClose: (id: string) => void;
  activeTab?: { id: string; kind: string; isDirty: boolean; filePath?: string } | null;
  isMd: boolean;
  isNote: boolean;
}

/** Build the shared File menu items used by both TitlebarMenuBar and useGlobalContextMenu. */
export function buildFileMenuItems(ctx: FileMenuContext): ContextMenuItem[] {
  const { addTab, onNewWhiteboard, onOpenMultiple, onOpenFolder, saveTabToFile, saveTabToFileAs, exportPDF, requestClose, activeTab, isMd, isNote } = ctx;
  return [
    { type: "item", label: "New Note",       icon: <FilePlus    size={13} />, shortcut: "Ctrl+N",   onClick: addTab },
    { type: "item", label: "New Whiteboard", icon: <SquarePen   size={13} />, shortcut: "Ctrl+3",   onClick: onNewWhiteboard },
    { type: "separator" },
    { type: "item", label: "Open File(s)",   icon: <Files       size={13} />, shortcut: "Ctrl+O",   onClick: onOpenMultiple },
    { type: "item", label: "Open Folder",    icon: <FolderOpen  size={13} />, shortcut: "Ctrl+\u21e7+O", onClick: onOpenFolder },
    { type: "separator" },
    { type: "item", label: "Save",           icon: <Save        size={13} />, shortcut: "Ctrl+S",   disabled: !isNote || !activeTab?.isDirty,  onClick: () => activeTab && saveTabToFile(activeTab.id) },
    { type: "item", label: "Save As\u2026",       icon: <SaveAll     size={13} />, shortcut: "Ctrl+\u21e7+S", disabled: !isNote,                         onClick: () => activeTab && saveTabToFileAs(activeTab.id) },
    { type: "item", label: "Export PDF",     icon: <FileDown    size={13} />, shortcut: "Ctrl+P",   disabled: !isMd,                            onClick: exportPDF },
    { type: "separator" },
    { type: "item", label: "Close Tab",      icon: <Trash2      size={13} />, shortcut: "Ctrl+W",   danger: true, disabled: !activeTab,         onClick: () => activeTab && requestClose(activeTab.id) },
  ];
}
