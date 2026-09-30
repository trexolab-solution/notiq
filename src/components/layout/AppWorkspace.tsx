import { lazy, Suspense } from "react";
import { Network } from "lucide-react";

import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { NoteActions } from "./NoteActions";
import { WhiteboardActions } from "./WhiteboardActions";
import { ViewLoader } from "./ViewLoader";
import { EditorContainer } from "../editor/EditorContainer";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { ErrorBoundary } from "../ui/ErrorBoundary";

import type { Tab, AppView } from "../../types";
import type { UseTerminalPanelResult } from "../../hooks/useTerminalPanel";

const KnowledgeGraph = lazy(() =>
  import("../graph/KnowledgeGraph").then((m) => ({ default: m.KnowledgeGraph }))
);
const Whiteboard = lazy(() =>
  import("../whiteboard/Whiteboard").then((m) => ({ default: m.Whiteboard }))
);
const AIChatPanel = lazy(() =>
  import("../ai/AIChatPanel").then((m) => ({ default: m.AIChatPanel }))
);

interface Props {
  activeView:          AppView;
  onViewChange:        (v: AppView) => void;
  onNewWhiteboard:     () => void;
  onOpenSettings:      () => void;
  requestClose:        (id: string) => void;
  activeTab:           Tab | undefined;
  onLinkedWhiteboard:  () => void;
  graphMounted:        boolean;
  term:                UseTerminalPanelResult;
  aiChatMounted:       boolean;
  aiChatOpen:          boolean;
  aiChatWidth:         number;
  onAiChatResizeStart: (e: React.MouseEvent) => void;
  onCloseAiChat:       () => void;
}

/**
 * The app's main workspace: sidebar, tab bar, the editor/whiteboard/graph
 * views, the terminal panel, and the docked AI chat panel. Extracted from
 * App — purely presentational, all state lives in App and is threaded
 * through as props.
 */
export function AppWorkspace({
  activeView, onViewChange, onNewWhiteboard, onOpenSettings, requestClose,
  activeTab, onLinkedWhiteboard, graphMounted, term,
  aiChatMounted, aiChatOpen, aiChatWidth, onAiChatResizeStart, onCloseAiChat,
}: Props) {
  return (
    <div className="app-body">
      <Sidebar
        activeView={activeView}
        onViewChange={onViewChange}
        onNewWhiteboard={onNewWhiteboard}
        onOpenSettings={onOpenSettings}
      />

      <div className="app-content-column">

        {/* ── Tab Bar ───────────────────────────────────────────────── */}
        <div className="tab-bar-row">
          <TabBar onCloseTab={requestClose} />

          {activeView === "editor" && activeTab?.kind === "note" && (
            <NoteActions tab={activeTab} onLinkedWhiteboard={onLinkedWhiteboard} />
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
          <div className="ai-chat-resize-handle" onMouseDown={onAiChatResizeStart} />
          <ErrorBoundary>
            <Suspense fallback={null}>
              <AIChatPanel onClose={onCloseAiChat} />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </div>
  );
}
