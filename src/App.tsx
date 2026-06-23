import { useState, useEffect, useCallback, useRef, lazy, Suspense } from "react";
import { Network, NotepadText, List, Sparkles, MessageSquare } from "lucide-react";

import { useSession }              from "./hooks/useSession";
import { useCloseTab }             from "./hooks/useCloseTab";
import { useGlobalShortcuts }      from "./hooks/useGlobalShortcuts";
import { useGlobalContextMenu }    from "./hooks/useGlobalContextMenu";
import { useTerminalPanel }        from "./hooks/useTerminalPanel";
import { useFileWatcher }          from "./hooks/useFileWatcher";

import { useAppStore }             from "./store";
import { isMarkdownLike }          from "./lib/language";
import { appWin }                  from "./lib/tauriWindow";
import { openStickyNote, openStickyNotesList } from "./lib/stickyNote";
import { toast } from "./lib/toast";
import { pickAndReadMultipleFiles, pickFolderAndReadFiles, type FileEntry } from "./lib/fileOps";
import { getFileName } from "./lib/pathUtils";
import { bootstrapAutostart } from "./lib/autostart";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { TabBar }                  from "./components/layout/TabBar";
import { Sidebar }                 from "./components/layout/Sidebar";
import { StatusBar }               from "./components/layout/StatusBar";
import { WindowControls }          from "./components/layout/WindowControls";
import { ViewLoader }              from "./components/layout/ViewLoader";
import { TitlebarModePicker }      from "./components/layout/TitlebarModePicker";
import { TitlebarMenuBar }         from "./components/layout/TitlebarMenuBar";
import { NoteActions }             from "./components/layout/NoteActions";
import { WhiteboardActions }       from "./components/layout/WhiteboardActions";
import { TerminalPanel }           from "./components/terminal/TerminalPanel";

import { EditorContainer }         from "./components/editor/EditorContainer";
import { AIOnboarding }            from "./components/ai/AIOnboarding";
import { AIChatPanel }            from "./components/ai/AIChatPanel";
import { CommandPalette, type Command } from "./components/ui/CommandPalette";
import { THEMES }                  from "./lib/themes";
import { getActiveEditor }         from "./lib/activeEditor";
import { aiContinue, aiSummarize, aiFixGrammar, aiGenerateTitle } from "./lib/ai/actions";
import {
  FileText as FileIcon, FilePlus, FolderOpen, Save, Settings as SettingsIcon,
  Network as NetworkIcon, Palette, MessageSquare as ChatIcon, SquarePen, PenLine, SpellCheck, Heading,
} from "lucide-react";
import { ContextMenu }             from "./components/ui/ContextMenu";
import { ConfirmDialog }           from "./components/ui/ConfirmDialog";
import { SettingsModal }           from "./components/ui/SettingsModal";
import { FileSelectionModal }      from "./components/ui/FileSelectionModal";
import { ToastProvider }           from "./components/ui/Toast";
import { Tooltip }                from "./components/ui/Tooltip";
import { ErrorBoundary }          from "./components/ui/ErrorBoundary";

import logoUrl                     from "./assets/logo.png";

const KnowledgeGraph = lazy(() =>
  import("./components/graph/KnowledgeGraph").then((m) => ({ default: m.KnowledgeGraph }))
);
const Whiteboard = lazy(() =>
  import("./components/whiteboard/Whiteboard").then((m) => ({ default: m.Whiteboard }))
);

export default function App() {
  useSession();
  useFileWatcher();
  const { pendingTab, requestClose, handleSaveAndClose, handleDiscardAndClose, handleCancelClose } = useCloseTab();

  const [showSettings,  setShowSettings]  = useState(false);
  const [settingsSection, setSettingsSection] = useState<"ai" | undefined>(undefined);
  const [showAIOnboarding, setShowAIOnboarding] = useState(false);
  const [showPalette,   setShowPalette]   = useState(false);
  const [aiChatOpen,    setAiChatOpen]    = useState(false);
  const [aiChatMounted, setAiChatMounted] = useState(false); // stays true after first open
  const [aiChatWidth,   setAiChatWidth]   = useState(() => {
    const saved = Number(localStorage.getItem("pref:aiChatWidth"));
    return saved >= 280 && saved <= 640 ? saved : 360;
  });
  const [fileSelection, setFileSelection] = useState<{ files: FileEntry[]; folderPath?: string } | null>(null);
  const [graphMounted,  setGraphMounted]  = useState(false);

  // Terminal panel — all state, drag/resize, window-clamp, and keyboard shortcuts.
  const term = useTerminalPanel();

  const tabs            = useAppStore((s) => s.tabs);
  const activeTabId     = useAppStore((s) => s.activeTabId);
  const addTab          = useAppStore((s) => s.addTab);
  const setActiveTab    = useAppStore((s) => s.setActiveTab);
  const openFilesAsTabs = useAppStore((s) => s.openFilesAsTabs);
  const activeView      = useAppStore((s) => s.activeView);
  const setActiveView   = useAppStore((s) => s.setActiveView);
  const aiEnabled       = useAppStore((s) => s.aiEnabled);
  const aiOnboarded     = useAppStore((s) => s.aiOnboarded);
  const setAiEnabled    = useAppStore((s) => s.setAiEnabled);
  const setTheme        = useAppStore((s) => s.setTheme);
  const saveTabToFile   = useAppStore((s) => s.saveTabToFile);

  // Header ✨ button: not set up → onboarding; set up → quick enable/disable toggle.
  const handleAIClick = useCallback(() => {
    if (!aiOnboarded) { setShowAIOnboarding(true); return; }
    const next = !aiEnabled;
    setAiEnabled(next);
    toast.info(next ? "AI assistance enabled" : "AI assistance disabled");
  }, [aiOnboarded, aiEnabled, setAiEnabled]);

  // Right-click the ✨ button → open the AI settings page.
  const openAISettings = useCallback(() => {
    setSettingsSection("ai");
    setShowSettings(true);
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isMdNote  = activeTab?.kind === "note" && isMarkdownLike(activeTab?.filePath);

  // Toggle the AI chat; mount-once so the conversation persists across open/close.
  const toggleAiChat = useCallback(() => {
    setAiChatMounted(true);
    setAiChatOpen((v) => !v);
  }, []);

  // Mount graph lazily on first tab (moved from render to effect to avoid setState during render)
  useEffect(() => {
    if (!graphMounted && tabs.length > 0) setGraphMounted(true);
  }, [graphMounted, tabs.length]);

  // Bootstrap auto-start on the very first launch of an installed build.
  useEffect(() => { bootstrapAutostart(); }, []);

  // AI chat panel resize (drag the left edge). Clamped 280–640px, persisted.
  const aiChatDraggingRef = useRef(false);
  const startAiChatResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    aiChatDraggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, []);
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!aiChatDraggingRef.current) return;
      // Panel is docked on the right, so width grows as the cursor moves left.
      const w = Math.min(640, Math.max(280, window.innerWidth - e.clientX));
      setAiChatWidth(w);
    };
    const onUp = () => {
      if (!aiChatDraggingRef.current) return;
      aiChatDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      localStorage.setItem("pref:aiChatWidth", String(aiChatWidth));
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [aiChatWidth]);

  // Window drag — manual startDragging because data-tauri-drag-region only
  // works on the element itself (not children), per Tauri docs.
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.buttons !== 1) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, input, a, select")) return;
    e.detail === 2 ? appWin?.toggleMaximize() : appWin?.startDragging();
  }, []);

  // Whiteboard helpers
  const handleNewWhiteboard = useCallback(() => {
    setActiveView("editor");
    const existing = tabs.find((t) => t.kind === "whiteboard" && !t.linkedNoteId);
    if (existing) { setActiveTab(existing.id); return; }
    addTab({ kind: "whiteboard", title: "Whiteboard" });
  }, [tabs, addTab, setActiveTab, setActiveView]);

  const handleLinkedWhiteboard = useCallback(() => {
    if (!activeTabId || activeTab?.kind !== "note") return;
    const existing = tabs.find((t) => t.kind === "whiteboard" && t.linkedNoteId === activeTabId);
    if (existing) { setActiveTab(existing.id); return; }
    addTab({ kind: "whiteboard", title: `${activeTab!.title} — Board`, linkedNoteId: activeTabId });
  }, [activeTabId, activeTab, tabs, addTab, setActiveTab]);

  // On startup: open file passed via file-association / CLI arg
  useEffect(() => {
    invoke<string | null>("get_open_file").then(async (filePath) => {
      if (!filePath) return;
      try {
        const content = await readTextFile(filePath);
        const name = getFileName(filePath) || "Note";
        const title = name.replace(/\.(md|markdown|txt|notiq)$/i, "");
        openFilesAsTabs([{ path: filePath, content, title }]);
      } catch { /* file unreadable — ignore */ }
    });
  }, []); // Init-once: reads from store via openFilesAsTabs (stable ref)

  // Drag-and-drop files from OS — uses Tauri's native webview drop event
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type === "enter") {
        setDragOver(true);
      } else if (event.payload.type === "leave") {
        setDragOver(false);
      } else if (event.payload.type === "drop") {
        setDragOver(false);
        const entries: FileEntry[] = [];
        for (const filePath of event.payload.paths) {
          try {
            const content = await readTextFile(filePath);
            const name = getFileName(filePath) || "Note";
            const title = name.replace(/\.(md|markdown|txt|notiq)$/i, "");
            entries.push({ path: filePath.replace(/\\/g, "/"), content, title });
          } catch { /* skip unreadable / binary */ }
        }
        if (entries.length) openFilesAsTabs(entries);
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []); // Init-once: drag-drop listener registered at mount

  // File open
  const handleOpenMultiple = useCallback(async () => {
    const files = await pickAndReadMultipleFiles();
    if (!files.length) return;
    openFilesAsTabs(files);
  }, [openFilesAsTabs]);

  const handleOpenFolder = useCallback(async () => {
    const result = await pickFolderAndReadFiles();
    if (!result) return;
    if (!result.files.length) return;
    setFileSelection(result);
  }, []);

  // ── Command palette ─────────────────────────────────────────────────────────
  const buildCommands = useCallback((): Command[] => {
    const cmds: Command[] = [];

    // Open tabs → switch
    for (const t of tabs) {
      cmds.push({
        id: `tab:${t.id}`,
        label: t.title || "Untitled",
        group: "Tabs",
        hint: t.filePath ? t.filePath.replace(/\\/g, "/").split("/").slice(-2).join("/") : undefined,
        trailing: t.id === activeTabId ? "current" : undefined,
        icon: <FileIcon size={14} />,
        run: () => { setActiveView("editor"); setActiveTab(t.id); },
      });
    }

    // App actions
    cmds.push(
      { id: "act:new-note", label: "New Note", group: "Actions", icon: <FilePlus size={14} />, trailing: "Ctrl+N", run: () => addTab() },
      { id: "act:new-wb", label: "New Whiteboard", group: "Actions", icon: <SquarePen size={14} />, trailing: "Ctrl+3", run: handleNewWhiteboard },
      { id: "act:open", label: "Open File(s)", group: "Actions", icon: <FolderOpen size={14} />, trailing: "Ctrl+O", run: handleOpenMultiple },
      { id: "act:open-folder", label: "Open Folder", group: "Actions", icon: <FolderOpen size={14} />, run: handleOpenFolder },
      { id: "act:save", label: "Save", group: "Actions", icon: <Save size={14} />, trailing: "Ctrl+S", run: () => { if (activeTabId) saveTabToFile(activeTabId); } },
      { id: "act:graph", label: "Knowledge Graph", group: "Actions", icon: <NetworkIcon size={14} />, run: () => setActiveView("graph") },
      { id: "act:editor", label: "Editor View", group: "Actions", icon: <FileIcon size={14} />, run: () => setActiveView("editor") },
      { id: "act:chat", label: "Toggle AI Chat", group: "Actions", icon: <ChatIcon size={14} />, run: toggleAiChat },
      { id: "act:settings", label: "Settings", group: "Actions", icon: <SettingsIcon size={14} />, trailing: "Ctrl+,", run: () => setShowSettings(true) },
    );

    // AI actions (only when an editor exists + AI is on)
    if (aiEnabled && getActiveEditor()) {
      cmds.push(
        { id: "ai:continue", label: "AI: Continue Writing", group: "AI", icon: <PenLine size={14} />, run: () => { const e = getActiveEditor(); if (e) void aiContinue(e); } },
        { id: "ai:summarize", label: "AI: Summarize Note", group: "AI", icon: <FileIcon size={14} />, run: () => { const e = getActiveEditor(); if (e) void aiSummarize(e); } },
        { id: "ai:grammar", label: "AI: Fix Grammar", group: "AI", icon: <SpellCheck size={14} />, run: () => { const e = getActiveEditor(); if (e) void aiFixGrammar(e); } },
        { id: "ai:title", label: "AI: Generate Title", group: "AI", icon: <Heading size={14} />, run: () => { const e = getActiveEditor(); if (e) void aiGenerateTitle(e); } },
      );
    }

    // Themes
    for (const th of Object.values(THEMES)) {
      cmds.push({
        id: `theme:${th.id}`,
        label: `Theme: ${th.label}`,
        group: "Theme",
        icon: <Palette size={14} />,
        run: () => setTheme(th.id),
      });
    }

    return cmds;
  }, [tabs, activeTabId, aiEnabled, addTab, setActiveTab, setActiveView, handleNewWhiteboard, handleOpenMultiple, handleOpenFolder, saveTabToFile, setTheme, toggleAiChat]);

  // Open the palette from the Monaco editor (which swallows Ctrl+Shift+P internally).
  useEffect(() => {
    const open = () => setShowPalette(true);
    window.addEventListener("app:command-palette", open);
    return () => window.removeEventListener("app:command-palette", open);
  }, []);

  useGlobalShortcuts({
    requestClose,
    handleOpenMultiple,
    handleOpenFolder,
    handleNewWhiteboard,
    onOpenSettings: () => setShowSettings(true),
    onOpenCommandPalette: () => setShowPalette(true),
  });

  const { ctxMenu, closeCtxMenu } = useGlobalContextMenu({
    requestClose,
    handleOpenMultiple,
    handleOpenFolder,
    handleNewWhiteboard,
    onShowGraph: () => setActiveView("graph"),
  });

  return (
    <div className="app-shell">

      {/* ── Titlebar ────────────────────────────────────────────────────── */}
      <header className="app-header" onMouseDown={handleHeaderMouseDown}>
        <div className="header-left">
          <div className="app-brand">
            <img src={logoUrl} alt="Notiq" draggable={false} className="app-brand-logo" />
            <span className="app-brand-name">Notiq</span>
          </div>

          <TitlebarMenuBar
            onNewWhiteboard={handleNewWhiteboard}
            onOpenMultiple={handleOpenMultiple}
            onOpenFolder={handleOpenFolder}
            onOpenSettings={() => setShowSettings(true)}
            onShowGraph={() => setActiveView("graph")}
            onShowEditor={() => setActiveView("editor")}
            requestClose={requestClose}
          />
        </div>

        <div className="header-center">
          {activeView === "editor" && activeTab?.kind === "note" && isMdNote && (
            <TitlebarModePicker tab={activeTab} />
          )}
        </div>

        <div className="header-right">
          <Tooltip
            content={
              !aiOnboarded
                ? "Set up AI"
                : aiEnabled
                  ? "AI on — click to disable · right-click for settings"
                  : "AI off — click to enable · right-click for settings"
            }
          >
            <button
              className="titlebar-tool-btn"
              aria-label="AI assistance"
              onClick={handleAIClick}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openAISettings(); }}
              style={aiOnboarded && aiEnabled ? { color: "var(--color-primary)" } : undefined}
            >
              <Sparkles size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <Tooltip content="AI Chat">
            <button
              className="titlebar-tool-btn"
              aria-label="AI Chat"
              onClick={toggleAiChat}
              style={aiChatOpen ? { color: "var(--color-primary)" } : undefined}
            >
              <MessageSquare size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <Tooltip content="New Sticky Note">
            <button className="titlebar-tool-btn" aria-label="New Sticky Note" onClick={() => openStickyNote()}>
              <NotepadText size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
          <Tooltip content="Sticky Notes List">
            <button className="titlebar-tool-btn" aria-label="Sticky Notes List" onClick={() => openStickyNotesList()}>
              <List size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
        </div>

        <WindowControls />
      </header>

      {/* ── Body ────────────────────────────────────────────────────────── */}
      <div className="app-body">
        <Sidebar
          activeView={activeView}
          onViewChange={setActiveView}
          onNewWhiteboard={handleNewWhiteboard}
          onOpenSettings={() => setShowSettings(true)}
        />

        <div className="app-content-column">

          {/* ── Tab Bar ───────────────────────────────────────────────── */}
          <div className="tab-bar-row">
            <TabBar onCloseTab={requestClose} />

            {activeView === "editor" && activeTab?.kind === "note" && (
              <NoteActions tab={activeTab} onLinkedWhiteboard={handleLinkedWhiteboard} />
            )}

            {activeView === "editor" && activeTab?.kind === "whiteboard" && (
              <WhiteboardActions tab={activeTab} />
            )}

            {activeView === "graph" && (
              <div className="tab-bar-view-label">
                <Network size={13} strokeWidth={1.8} /><span>Knowledge Graph</span>
              </div>
            )}
          </div>

          {/* ── Main + terminal row (flex direction follows terminal layout) ── */}
          <div className={`app-main-row ${term.layout}`}>
            <main className="app-main">
              {activeView === "editor" && (
                activeTab?.kind === "whiteboard" ? (
                  <ErrorBoundary>
                    <Suspense fallback={<ViewLoader view="whiteboard" />}>
                      <Whiteboard tabId={activeTab.id} linkedNoteId={activeTab.linkedNoteId} />
                    </Suspense>
                  </ErrorBoundary>
                ) : (
                  <EditorContainer />
                )
              )}

              {graphMounted && (
                <div
                  className="app-graph-layer"
                  style={{ display: activeView === "graph" ? "flex" : "none" }}
                >
                  <ErrorBoundary>
                    <Suspense fallback={activeView === "graph" ? <ViewLoader view="graph" /> : null}>
                      <KnowledgeGraph />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )}
            </main>

            {/* ── Terminal panel ────────────────────────────────────────── */}
            {term.mounted && (
              <div
                className="terminal-section"
                style={
                  term.layout === "horizontal"
                    ? { height: term.isOpen ? term.height : 0 }
                    : { width:  term.isOpen ? term.width  : 0 }
                }
              >
                <div
                  className="terminal-resize-handle"
                  onMouseDown={term.onResizeDrag}
                />
                <ErrorBoundary>
                  <TerminalPanel
                    ref={term.panelRef}
                    isOpen={term.isOpen}
                    onClose={term.close}
                    layout={term.layout}
                    onToggleLayout={term.toggleLayout}
                  />
                </ErrorBoundary>
              </div>
            )}
          </div>

        </div>

        {/* ── AI Chat panel (docked right, resizable) ───────────────────────
            Stays mounted once first opened and is hidden with display:none when
            closed, so the in-progress conversation survives panel toggles. */}
        {aiChatMounted && (
          <div
            className="ai-chat-section"
            style={{ width: aiChatWidth, display: aiChatOpen ? undefined : "none" }}
          >
            <div className="ai-chat-resize-handle" onMouseDown={startAiChatResize} />
            <ErrorBoundary>
              <AIChatPanel onClose={() => setAiChatOpen(false)} />
            </ErrorBoundary>
          </div>
        )}
      </div>

      <StatusBar
        terminalOpen={term.isOpen}
        onToggleTerminal={term.toggle}
      />

      {/* ── Overlays ────────────────────────────────────────────────────── */}
      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} items={ctxMenu.items} onClose={closeCtxMenu} />
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => { setShowSettings(false); setSettingsSection(undefined); }}
          initialSection={settingsSection}
          onRunAIOnboarding={() => {
            setShowSettings(false);
            setSettingsSection(undefined);
            setShowAIOnboarding(true);
          }}
        />
      )}

      {showAIOnboarding && <AIOnboarding onClose={() => setShowAIOnboarding(false)} />}

      {showPalette && (
        <CommandPalette commands={buildCommands()} onClose={() => setShowPalette(false)} />
      )}

      {fileSelection && (
        <FileSelectionModal
          files={fileSelection.files}
          folderPath={fileSelection.folderPath}
          onConfirm={(selected) => {
            setFileSelection(null);
            openFilesAsTabs(selected);
            // Auto-switch to graph view so the user sees the knowledge graph populate
            if (selected.length >= 2) {
              setGraphMounted(true);
              setActiveView("graph");
            }
          }}
          onCancel={() => setFileSelection(null)}
        />
      )}

      {pendingTab && (
        pendingTab.kind === "whiteboard" ? (
          <ConfirmDialog
            title="Close whiteboard?"
            message="This whiteboard has drawings. Closing the tab will permanently delete the canvas data."
            detail={pendingTab.title}
            icon="whiteboard"
            confirmLabel="Discard & Close"
            danger
            onConfirm={handleDiscardAndClose}
            onCancel={handleCancelClose}
          />
        ) : (
          <ConfirmDialog
            title="Unsaved changes"
            message={
              pendingTab.filePath
                ? "This note has unsaved changes. Save before closing?"
                : "This note has never been saved to disk. Close without saving?"
            }
            detail={pendingTab.title}
            icon="file"
            confirmLabel={pendingTab.filePath ? "Save" : "Save As"}
            discardLabel="Discard"
            cancelLabel="Cancel"
            onConfirm={handleSaveAndClose}
            onDiscard={handleDiscardAndClose}
            onCancel={handleCancelClose}
          />
        )
      )}

      <ToastProvider />

      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-overlay-label">Drop files to open</div>
        </div>
      )}
    </div>
  );
}
