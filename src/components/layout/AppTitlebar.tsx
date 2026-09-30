import { NotepadText, List, Sparkles, MessageSquare } from "lucide-react";
import { openStickyNote, openStickyNotesList } from "../../lib/stickyNote";
import type { Tab, AppView } from "../../types";

import { TitlebarMenuBar } from "./TitlebarMenuBar";
import { TitlebarModePicker } from "./TitlebarModePicker";
import { WindowControls } from "./WindowControls";
import { UpdateButton } from "./UpdateButton";
import { Tooltip } from "../ui/Tooltip";

import logoUrl from "../../assets/logo.png";

interface Props {
  onHeaderMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  onNewWhiteboard:   () => void;
  onOpenMultiple:    () => void;
  onOpenFolder:      () => void;
  onOpenSettings:    () => void;
  onShowGraph:       () => void;
  onShowEditor:      () => void;
  requestClose:      (id: string) => void;
  activeView:        AppView;
  activeTab:         Tab | undefined;
  isMdNote:          boolean;
  aiOnboarded:       boolean;
  aiEnabled:         boolean;
  aiChatOpen:        boolean;
  onAIClick:         () => void;
  onOpenAISettings:  () => void;
  onToggleAiChat:    () => void;
}

/**
 * App titlebar: brand + File/View menu, editor mode picker, AI / sticky-note
 * tools, and window controls. Extracted from App — purely presentational,
 * all state lives in App and is threaded through as props.
 */
export function AppTitlebar({
  onHeaderMouseDown, onNewWhiteboard, onOpenMultiple, onOpenFolder, onOpenSettings,
  onShowGraph, onShowEditor, requestClose, activeView, activeTab, isMdNote,
  aiOnboarded, aiEnabled, aiChatOpen, onAIClick, onOpenAISettings, onToggleAiChat,
}: Props) {
  return (
    <header className="app-header" onMouseDown={onHeaderMouseDown}>
      <div className="header-left">
        <div className="app-brand">
          <img src={logoUrl} alt="Notiq" draggable={false} className="app-brand-logo" />
          <span className="app-brand-name">Notiq</span>
        </div>

        <TitlebarMenuBar
          onNewWhiteboard={onNewWhiteboard}
          onOpenMultiple={onOpenMultiple}
          onOpenFolder={onOpenFolder}
          onOpenSettings={onOpenSettings}
          onShowGraph={onShowGraph}
          onShowEditor={onShowEditor}
          requestClose={requestClose}
        />
      </div>

      <div className="header-center">
        {activeView === "editor" && activeTab?.kind === "note" && isMdNote && (
          <TitlebarModePicker tab={activeTab} />
        )}
      </div>

      <div className="header-right">
        <UpdateButton />
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
            data-tour="ai-button"
            onClick={onAIClick}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onOpenAISettings(); }}
            style={aiOnboarded && aiEnabled ? { color: "var(--color-primary)" } : undefined}
          >
            <Sparkles size={15} strokeWidth={1.7} />
          </button>
        </Tooltip>
        <Tooltip content="AI Chat">
          <button
            className="titlebar-tool-btn"
            aria-label="AI Chat"
            data-tour="ai-chat"
            onClick={onToggleAiChat}
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
  );
}
