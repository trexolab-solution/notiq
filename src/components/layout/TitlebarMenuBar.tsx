import { useEffect, useRef, useState } from "react";
import {
  Code2, Columns2, Eye, FileDown, FilePlus, Files, FileText, FolderOpen,
  Network, PenTool, Save, SaveAll, Settings,
} from "lucide-react";
import { useAppStore } from "../../store";
import { exportToPDF } from "../../lib/pdfExport";
import { isMarkdownLike } from "../../lib/language";
import { buildFileMenuItems } from "../../lib/menuItems";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { Tooltip } from "../ui/Tooltip";

interface Props {
  onNewWhiteboard: () => void;
  onOpenMultiple:  () => void;
  onOpenFolder:    () => void;
  onOpenSettings:  () => void;
  onShowGraph:     () => void;
  onShowEditor:    () => void;
  requestClose:    (id: string) => void;
}

type MenuName = "file" | "view";

export function TitlebarMenuBar({
  onNewWhiteboard, onOpenMultiple, onOpenFolder, onOpenSettings,
  onShowGraph, onShowEditor, requestClose,
}: Props) {
  const tabs                = useAppStore((s) => s.tabs);
  const activeTabId         = useAppStore((s) => s.activeTabId);
  const activeView          = useAppStore((s) => s.activeView);
  const addTab              = useAppStore((s) => s.addTab);
  const saveTabToFile       = useAppStore((s) => s.saveTabToFile);
  const saveTabToFileAs     = useAppStore((s) => s.saveTabToFileAs);
  const updateTabEditorMode = useAppStore((s) => s.updateTabEditorMode);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isNote    = activeTab?.kind === "note";
  const isMd      = isNote && isMarkdownLike(activeTab.filePath);
  const hasDirty  = tabs.some((t) => t.kind === "note" && t.isDirty);

  const [open,   setOpen]   = useState<MenuName | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t?.closest(".titlebar-menu-btn")) return;
      if (t?.closest(".context-menu"))      return;
      setOpen(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  function handleTrigger(name: MenuName, e: React.MouseEvent<HTMLButtonElement>) {
    if (open === name) { setOpen(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom + 2 });
    setOpen(name);
  }

  function handleHover(name: MenuName, e: React.MouseEvent<HTMLButtonElement>) {
    if (!open || open === name) return;
    const r = e.currentTarget.getBoundingClientRect();
    setAnchor({ x: r.left, y: r.bottom + 2 });
    setOpen(name);
  }

  async function handleSaveAll() {
    const dirtyNotes = tabs.filter((t) => t.kind === "note" && t.isDirty);
    await Promise.all(dirtyNotes.map((t) => saveTabToFile(t.id)));
  }

  // ── Menu definitions ─────────────────────────────────────────────────────
  const fileItems = buildFileMenuItems({
    addTab: () => addTab(),
    onNewWhiteboard,
    onOpenMultiple,
    onOpenFolder,
    saveTabToFile,
    saveTabToFileAs,
    exportPDF: () => activeTab && exportToPDF(activeTab.title, activeTab.content),
    requestClose,
    activeTab: activeTab ?? null,
    isMd,
    isNote,
  });

  const viewItems: ContextMenuItem[] = [
    { type: "label", label: "Workspace" },
    { type: "item", label: "Editor",          icon: <FileText size={13} />,                       disabled: activeView === "editor", onClick: onShowEditor },
    { type: "item", label: "Knowledge Graph", icon: <Network  size={13} />,                       disabled: activeView === "graph",  onClick: onShowGraph  },
    { type: "item", label: "Whiteboard",      icon: <PenTool  size={13} />,                                                          onClick: onNewWhiteboard },
    ...(isMd ? [
      { type: "separator" as const },
      { type: "label" as const, label: "Editor mode" },
      { type: "item" as const, label: "Source",  icon: <Code2    size={13} />, disabled: activeTab.editorMode === "markdown", onClick: () => updateTabEditorMode(activeTab.id, "markdown") },
      { type: "item" as const, label: "Preview", icon: <Eye      size={13} />, disabled: activeTab.editorMode === "preview",  onClick: () => updateTabEditorMode(activeTab.id, "preview")  },
      { type: "item" as const, label: "Split",   icon: <Columns2 size={13} />, disabled: activeTab.editorMode === "split",    onClick: () => updateTabEditorMode(activeTab.id, "split")    },
    ] : []),
    { type: "separator" },
    { type: "item", label: "Settings", icon: <Settings size={13} />, shortcut: "Ctrl+,", onClick: onOpenSettings },
  ];

  return (
    <div className="titlebar-menubar" ref={barRef}>
      {/* ── Dropdown menus ─────────────────────────────────────────── */}
      <button
        className={`titlebar-menu-btn${open === "file" ? " is-open" : ""}`}
        onMouseDown={(e) => e.nativeEvent.stopPropagation()}
        onClick={(e) => handleTrigger("file", e)}
        onMouseEnter={(e) => handleHover("file", e)}
      >
        File
      </button>
      <button
        className={`titlebar-menu-btn${open === "view" ? " is-open" : ""}`}
        onMouseDown={(e) => e.nativeEvent.stopPropagation()}
        onClick={(e) => handleTrigger("view", e)}
        onMouseEnter={(e) => handleHover("view", e)}
      >
        View
      </button>

      {/* ── Quick-action icon toolbar ───────────────────────────────── */}
      <div className="titlebar-toolbar">
        <div className="titlebar-vsep" />

        <Tooltip content="New Note" shortcut="Ctrl+N">
          <button
            className="titlebar-tool-btn"
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={() => addTab()}
          >
            <FilePlus size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <Tooltip content="Open File(s)" shortcut="Ctrl+O">
          <button
            className="titlebar-tool-btn"
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={onOpenMultiple}
          >
            <Files size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <Tooltip content="Open Folder" shortcut="Ctrl+⇧+O">
          <button
            className="titlebar-tool-btn"
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={onOpenFolder}
          >
            <FolderOpen size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <div className="titlebar-vsep" />

        <Tooltip content="Save" shortcut="Ctrl+S">
          <button
            className={`titlebar-tool-btn${isNote && activeTab?.isDirty ? " is-dirty" : ""}`}
            disabled={!isNote || !activeTab?.isDirty}
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={() => activeTab && saveTabToFile(activeTab.id)}
          >
            <Save size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <Tooltip content="Save All">
          <button
            className={`titlebar-tool-btn${hasDirty ? " is-dirty" : ""}`}
            disabled={!hasDirty}
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={handleSaveAll}
          >
            <SaveAll size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <div className="titlebar-vsep" />

        <Tooltip content="Export as PDF" shortcut="Ctrl+P">
          <button
            className="titlebar-tool-btn"
            disabled={!isMd}
            onMouseDown={(e) => e.nativeEvent.stopPropagation()}
            onClick={() => activeTab && exportToPDF(activeTab.title, activeTab.content)}
          >
            <FileDown size={14} strokeWidth={1.8} />
          </button>
        </Tooltip>
      </div>

      {open && (
        <ContextMenu
          x={anchor.x}
          y={anchor.y}
          items={open === "file" ? fileItems : viewItems}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
