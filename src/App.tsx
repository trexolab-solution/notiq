import { useState, useEffect, useCallback } from "react";

import { useSession }              from "./hooks/useSession";
import { useCloseTab }             from "./hooks/useCloseTab";
import { useGlobalShortcuts }      from "./hooks/useGlobalShortcuts";
import { useGlobalContextMenu }    from "./hooks/useGlobalContextMenu";
import { useTerminalPanel }        from "./hooks/useTerminalPanel";
import { useFileWatcher }          from "./hooks/useFileWatcher";
import { useCommands }             from "./hooks/useCommands";
import { useAiChatPanel }          from "./hooks/useAiChatPanel";
import { useAppStartup }           from "./hooks/useAppStartup";

import { useAppStore }             from "./store";
import { isMarkdownLike }          from "./lib/language";
import { appWin }                  from "./lib/tauriWindow";
import { toast } from "./lib/toast";
import { pickAndReadMultipleFiles, pickFolderAndReadFiles, type FileEntry } from "./lib/fileOps";

import { AppTitlebar }              from "./components/layout/AppTitlebar";
import { AppWorkspace }             from "./components/layout/AppWorkspace";
import { AppOverlays }              from "./components/layout/AppOverlays";
import { StatusBar }               from "./components/layout/StatusBar";

export default function App() {
  useSession();
  useFileWatcher();
  const { pendingTab, requestClose, handleSaveAndClose, handleDiscardAndClose, handleCancelClose } = useCloseTab();

  const [showSettings,  setShowSettings]  = useState(false);
  const [settingsSection, setSettingsSection] = useState<"ai" | undefined>(undefined);
  const [showAIOnboarding, setShowAIOnboarding] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [showPalette,   setShowPalette]   = useState(false);
  const [showSearch,    setShowSearch]    = useState(false);
  const [aiChatOpen,    setAiChatOpen]    = useState(false);
  const [aiChatMounted, setAiChatMounted] = useState(false); // stays true after first open
  const [fileSelection, setFileSelection] = useState<{ files: FileEntry[]; folderPath?: string } | null>(null);
  const [graphMounted,  setGraphMounted]  = useState(false);

  // Terminal panel — all state, drag/resize, window-clamp, and keyboard shortcuts.
  const term = useTerminalPanel();

  // AI chat panel width + edge-drag resize (docked right, clamped 280–640px).
  const { width: aiChatWidth, startResize: startAiChatResize } = useAiChatPanel();

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
  const navigateToNote  = useAppStore((s) => s.navigateToNote);

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

  // Startup effects: autostart bootstrap, background update check, first-run
  // tour / What's New note, opening a file passed via file-association / CLI
  // arg, OS drag-and-drop, and the command-palette/search/tour event bridge.
  const { dragOver } = useAppStartup({ setShowTour, setShowSettings, setShowPalette, setShowSearch });

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
  const buildCommands = useCommands({
    tabs, activeTabId, aiEnabled,
    addTab, setActiveTab, setActiveView,
    handleNewWhiteboard, handleOpenMultiple, handleOpenFolder,
    saveTabToFile, setTheme, toggleAiChat,
    onOpenSettings: () => setShowSettings(true),
    onOpenSearch: () => setShowSearch(true),
  });

  useGlobalShortcuts({
    requestClose,
    handleOpenMultiple,
    handleOpenFolder,
    handleNewWhiteboard,
    onOpenSettings: () => setShowSettings(true),
    onOpenCommandPalette: () => setShowPalette(true),
    onOpenSearch: () => setShowSearch(true),
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

      <AppTitlebar
        onHeaderMouseDown={handleHeaderMouseDown}
        onNewWhiteboard={handleNewWhiteboard}
        onOpenMultiple={handleOpenMultiple}
        onOpenFolder={handleOpenFolder}
        onOpenSettings={() => setShowSettings(true)}
        onShowGraph={() => setActiveView("graph")}
        onShowEditor={() => setActiveView("editor")}
        requestClose={requestClose}
        activeView={activeView}
        activeTab={activeTab}
        isMdNote={isMdNote}
        aiOnboarded={aiOnboarded}
        aiEnabled={aiEnabled}
        aiChatOpen={aiChatOpen}
        onAIClick={handleAIClick}
        onOpenAISettings={openAISettings}
        onToggleAiChat={toggleAiChat}
      />

      <AppWorkspace
        activeView={activeView}
        onViewChange={setActiveView}
        onNewWhiteboard={handleNewWhiteboard}
        onOpenSettings={() => setShowSettings(true)}
        requestClose={requestClose}
        activeTab={activeTab}
        onLinkedWhiteboard={handleLinkedWhiteboard}
        graphMounted={graphMounted}
        term={term}
        aiChatMounted={aiChatMounted}
        aiChatOpen={aiChatOpen}
        aiChatWidth={aiChatWidth}
        onAiChatResizeStart={startAiChatResize}
        onCloseAiChat={() => setAiChatOpen(false)}
      />

      <StatusBar
        terminalOpen={term.isOpen}
        onToggleTerminal={term.toggle}
      />

      <AppOverlays
        ctxMenu={ctxMenu}
        closeCtxMenu={closeCtxMenu}
        showSettings={showSettings}
        setShowSettings={setShowSettings}
        settingsSection={settingsSection}
        setSettingsSection={setSettingsSection}
        showAIOnboarding={showAIOnboarding}
        setShowAIOnboarding={setShowAIOnboarding}
        showTour={showTour}
        setShowTour={setShowTour}
        showPalette={showPalette}
        setShowPalette={setShowPalette}
        buildCommands={buildCommands}
        showSearch={showSearch}
        setShowSearch={setShowSearch}
        tabs={tabs}
        navigateToNote={navigateToNote}
        fileSelection={fileSelection}
        setFileSelection={setFileSelection}
        openFilesAsTabs={openFilesAsTabs}
        setGraphMounted={setGraphMounted}
        setActiveView={setActiveView}
        pendingTab={pendingTab}
        handleSaveAndClose={handleSaveAndClose}
        handleDiscardAndClose={handleDiscardAndClose}
        handleCancelClose={handleCancelClose}
        dragOver={dragOver}
      />
    </div>
  );
}
