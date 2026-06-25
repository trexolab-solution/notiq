import { useCallback } from "react";
import {
  FileText as FileIcon, FilePlus, FolderOpen, Save, Settings as SettingsIcon,
  Network as NetworkIcon, Palette, MessageSquare as ChatIcon, SquarePen, PenLine, SpellCheck, Heading,
} from "lucide-react";
import type { Command } from "../components/ui/CommandPalette";
import type { Tab, AppView, ThemeId } from "../types";
import { THEMES } from "../lib/themes";
import { getActiveEditor } from "../lib/activeEditor";
import { aiContinue, aiSummarize, aiFixGrammar, aiGenerateTitle } from "../lib/ai/actions";

interface UseCommandsDeps {
  tabs: Tab[];
  activeTabId: string | null;
  aiEnabled: boolean;
  addTab: (overrides?: Partial<Tab>) => void;
  setActiveTab: (id: string) => void;
  setActiveView: (view: AppView) => void;
  handleNewWhiteboard: () => void;
  handleOpenMultiple: () => Promise<void>;
  handleOpenFolder: () => Promise<void>;
  saveTabToFile: (id: string) => Promise<boolean>;
  setTheme: (id: ThemeId) => void;
  toggleAiChat: () => void;
  onOpenSettings: () => void;
}

/**
 * Builds the command-palette command list from the current app state.
 * Extracted from App so the (large) command catalog lives on its own.
 */
export function useCommands(deps: UseCommandsDeps): () => Command[] {
  const {
    tabs, activeTabId, aiEnabled,
    addTab, setActiveTab, setActiveView,
    handleNewWhiteboard, handleOpenMultiple, handleOpenFolder,
    saveTabToFile, setTheme, toggleAiChat, onOpenSettings,
  } = deps;

  return useCallback((): Command[] => {
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
      { id: "act:settings", label: "Settings", group: "Actions", icon: <SettingsIcon size={14} />, trailing: "Ctrl+,", run: onOpenSettings },
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
  }, [tabs, activeTabId, aiEnabled, addTab, setActiveTab, setActiveView, handleNewWhiteboard, handleOpenMultiple, handleOpenFolder, saveTabToFile, setTheme, toggleAiChat, onOpenSettings]);
}
