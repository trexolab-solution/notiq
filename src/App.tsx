import { useState, useEffect, useCallback, useRef } from "react";
import { aiProblem } from "./lib/ai/verify";

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
import { publishAutofillTheme }    from "./lib/autofillTheme";
import { isMarkdownLike }          from "./lib/language";
import { displayPathOf }           from "./lib/vault";
import { LOGIN_EXT }               from "./lib/loginEntry";
import { SECRET_KINDS }            from "./lib/secretEntry";
import { appWin }                  from "./lib/tauriWindow";
import { toast } from "./lib/toast";
import { pickAndReadMultipleFiles, pickFolderAndReadFiles, type FileEntry } from "./lib/fileOps";
import { ALL_SETTINGS }            from "./lib/settingsRegistry";
import { settingsCommandsFor }     from "./lib/settingsCommands";

import { AppTitlebar }              from "./components/layout/AppTitlebar";
import { AppWorkspace }             from "./components/layout/AppWorkspace";
import { AppOverlays }              from "./components/layout/AppOverlays";
import { RestoreRequestHost }       from "./components/vault/RestoreRequestHost";
import { StatusBar }               from "./components/layout/StatusBar";

export default function App() {
  useSession();
  useFileWatcher();
  const { pendingTab, requestClose, handleSaveAndClose, handleDiscardAndClose, handleCancelClose } = useCloseTab();

  const [showAIOnboarding, setShowAIOnboarding] = useState(false);
  const [showTour, setShowTour] = useState(false);
  const [showPalette,   setShowPalette]   = useState(false);
  const [showSearch,    setShowSearch]    = useState(false);
  const [aiChatOpen,    setAiChatOpen]    = useState(false);
  const [aiChatMounted, setAiChatMounted] = useState(false); // stays true after first open
  const [fileSelection, setFileSelection] = useState<{ files: FileEntry[]; folderPath?: string } | null>(null);

  // Terminal panel — all state, drag/resize, window-clamp, and keyboard shortcuts.
  const term = useTerminalPanel();

  // AI chat panel width + edge-drag resize (docked right, clamped 280–640px).
  const { width: aiChatWidth, startResize: startAiChatResize } = useAiChatPanel();

  const tabs            = useAppStore((s) => s.tabs);
  const activeTabId     = useAppStore((s) => s.activeTabId);
  const addTab          = useAppStore((s) => s.addTab);
  const setActiveTab    = useAppStore((s) => s.setActiveTab);
  const openFilesAsTabs = useAppStore((s) => s.openFilesAsTabs);
  const aiEnabled       = useAppStore((s) => s.aiEnabled);
  const aiOnboarded     = useAppStore((s) => s.aiOnboarded);
  const setAiEnabled    = useAppStore((s) => s.setAiEnabled);
  const setTheme        = useAppStore((s) => s.setTheme);
  const saveTabToFile   = useAppStore((s) => s.saveTabToFile);
  const navigateToNote  = useAppStore((s) => s.navigateToNote);
  const openSettings    = useAppStore((s) => s.openSettings);

  // Header ✨ button: not set up → onboarding; set up → quick enable/disable toggle.
  // Switching on is checked first: "enabled" must not be followed by "your key is invalid".
  const checkingAi = useRef(false);
  const handleAIClick = useCallback(() => {
    if (!aiOnboarded) { setShowAIOnboarding(true); return; }
    if (aiEnabled) { setAiEnabled(false); toast.info("AI assistance disabled"); return; }
    if (checkingAi.current) return;
    checkingAi.current = true;
    const waiting = toast.info("Checking AI…", 60000);
    void aiProblem().then((problem) => {
      toast.remove(waiting);
      if (!problem) { setAiEnabled(true); toast.success("AI assistance enabled"); return; }
      toast.warning(`AI stays off: ${problem}`, {
        source: "AI", actions: [{ label: "Open Settings", onClick: () => useAppStore.getState().openSettings("ai") }],
      });
    }).finally(() => { checkingAi.current = false; });
  }, [aiOnboarded, aiEnabled, setAiEnabled]);

  // Settings is a tab: every entry point goes through the store's `openSettings`.
  const handleOpenSettings = useCallback(() => openSettings(), [openSettings]);
  // Right-click the ✨ button → the AI section of Settings.
  const openAISettings = useCallback(() => openSettings("ai"), [openSettings]);
  // Command palette: typing also lists matching settings ("Settings › Section › Label").
  const settingsQueryCommands = useCallback(
    (q: string) => settingsCommandsFor(q, ALL_SETTINGS, openSettings), [openSettings],
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);
  // Locked notes live in `.nqv`; judge them by their original type. Login/secret
  // entries use a form (no editor modes), and a locked tab shows only the unlock screen.
  const isStructuredEntry = !!activeTab?.vaultExt && (activeTab.vaultExt === LOGIN_EXT || !!SECRET_KINDS[activeTab.vaultExt]);
  const isMdNote  = activeTab?.kind === "note" && !activeTab.vaultLocked && !isStructuredEntry
    && isMarkdownLike(displayPathOf(activeTab)) && !activeTab.language;

  // Toggle the AI chat; mount-once so the conversation persists across open/close.
  const toggleAiChat = useCallback(() => {
    setAiChatMounted(true);
    setAiChatOpen((v) => !v);
  }, []);

  // Share the current theme with the browser extension (startup + every change). Main window only.
  const themeId = useAppStore((s) => s.themeId);
  useEffect(() => { publishAutofillTheme(themeId); }, [themeId]);

  // Startup effects: autostart bootstrap, background update check, first-run
  // tour / What's New note, opening a file passed via file-association / CLI
  // arg, OS drag-and-drop, and the command-palette/search/tour event bridge.
  const { dragOver } = useAppStartup({ setShowTour, setShowAIOnboarding, setShowPalette, setShowSearch });

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
    const existing = tabs.find((t) => t.kind === "whiteboard" && !t.linkedNoteId);
    if (existing) { setActiveTab(existing.id); return; }
    addTab({ kind: "whiteboard", title: "Whiteboard" });
  }, [tabs, addTab, setActiveTab]);

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
    addTab, setActiveTab,
    handleNewWhiteboard, handleOpenMultiple, handleOpenFolder,
    saveTabToFile, setTheme, toggleAiChat,
    onOpenSettings: handleOpenSettings,
    openSettings,
    onOpenSearch: () => setShowSearch(true),
  });

  useGlobalShortcuts({
    requestClose,
    handleOpenMultiple,
    handleOpenFolder,
    handleNewWhiteboard,
    onOpenSettings: handleOpenSettings,
    onOpenCommandPalette: () => setShowPalette(true),
    onOpenSearch: () => setShowSearch(true),
  });

  const { ctxMenu, closeCtxMenu } = useGlobalContextMenu({
    handleOpenMultiple,
    handleOpenFolder,
    handleNewWhiteboard,
  });

  return (
    <div className="app-shell">

      <AppTitlebar
        onHeaderMouseDown={handleHeaderMouseDown}
        onNewWhiteboard={handleNewWhiteboard}
        onOpenMultiple={handleOpenMultiple}
        onOpenFolder={handleOpenFolder}
        onOpenSettings={handleOpenSettings}
        requestClose={requestClose}
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
        onNewWhiteboard={handleNewWhiteboard}
        requestClose={requestClose}
        activeTab={activeTab}
        onLinkedWhiteboard={handleLinkedWhiteboard}
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

      <RestoreRequestHost />

      <AppOverlays
        ctxMenu={ctxMenu}
        closeCtxMenu={closeCtxMenu}
        showAIOnboarding={showAIOnboarding}
        setShowAIOnboarding={setShowAIOnboarding}
        showTour={showTour}
        setShowTour={setShowTour}
        showPalette={showPalette}
        setShowPalette={setShowPalette}
        buildCommands={buildCommands}
        queryCommands={settingsQueryCommands}
        showSearch={showSearch}
        setShowSearch={setShowSearch}
        tabs={tabs}
        navigateToNote={navigateToNote}
        fileSelection={fileSelection}
        setFileSelection={setFileSelection}
        openFilesAsTabs={openFilesAsTabs}
        pendingTab={pendingTab}
        handleSaveAndClose={handleSaveAndClose}
        handleDiscardAndClose={handleDiscardAndClose}
        handleCancelClose={handleCancelClose}
        dragOver={dragOver}
      />
    </div>
  );
}
