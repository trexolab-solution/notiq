import React, { useEffect, useMemo, useState } from "react";
import { HardDrive, SquareTerminal, Loader2 } from "lucide-react";
import { useAppStore } from "../../store";
import { Tooltip } from "../ui/Tooltip";
import { subscribeBusyDelayed } from "../../lib/ai/activity";
import { APP_NAME, APP_VERSION } from "../../config/app";

/** True while AI work is in flight, with delayed-show timing so quick
 *  autocomplete responses never flash the indicator. */
function useAiBusy(): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => subscribeBusyDelayed(setBusy), []);
  return busy;
}

const MODE_LABEL: Record<string, string> = {
  markdown: "Source",
  preview:  "Preview",
  split:    "Split",
};

interface Props {
  terminalOpen:     boolean;
  onToggleTerminal: () => void;
}

export const StatusBar = React.memo(function StatusBar({
  terminalOpen,
  onToggleTerminal,
}: Props) {
  const tabs        = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const themeId     = useAppStore((s) => s.themeId);
  const activeTab   = tabs.find((t) => t.id === activeTabId);
  const aiBusy      = useAiBusy();

  const { words, chars } = useMemo(() => {
    if (!activeTab || activeTab.kind === "whiteboard") return { words: 0, chars: 0 };
    const plain = activeTab.content
      .replace(/```[\s\S]*?```/g, " ").replace(/`[^`]+`/g, " ")
      .replace(/#{1,6}\s/g, "").replace(/[*_~\[\]()>]/g, "")
      .trim();
    return {
      words: plain ? plain.split(/\s+/).filter(Boolean).length : 0,
      chars: activeTab.content.length,
    };
  }, [activeTab]);

  const shortPath = useMemo(() => {
    if (!activeTab?.filePath) return null;
    const parts = activeTab.filePath.replace(/\\/g, "/").split("/");
    return parts.length > 2 ? `\u2026/${parts.slice(-2).join("/")}` : activeTab.filePath;
  }, [activeTab]);

  return (
    <div className="status-bar">
      {/* Left: terminal toggle + cursor position + word/char counts */}
      <div className="status-group">
        <Tooltip content="Toggle Terminal" shortcut="Ctrl+`">
          <button
            className={`status-terminal-btn${terminalOpen ? " is-active" : ""}`}
            onClick={onToggleTerminal}
          >
            <SquareTerminal size={12} />
            <span>Terminal</span>
          </button>
        </Tooltip>

        {activeTab ? (
          <>
            <span className="status-item">
              Ln {activeTab.cursorPosition.line}:{activeTab.cursorPosition.column}
            </span>
            <span className="status-item">{words.toLocaleString()} words</span>
            <span className="status-item">{chars.toLocaleString()} chars</span>
          </>
        ) : (
          <span className="status-item">Smart Note</span>
        )}
      </div>

      {/* Right: AI activity + save state + mode + theme */}
      <div className="status-group">
        {aiBusy && (
          <span className="status-item status-ai-indicator" aria-live="polite">
            <Loader2 size={11} />
            Thinking…
          </span>
        )}
        {activeTab && (
          <>
            {activeTab.kind === "whiteboard" ? (
              <span className="status-item">Auto-saved</span>
            ) : activeTab.isDirty ? (
              <span className="status-item unsaved">● Unsaved</span>
            ) : shortPath ? (
              <span className="status-item saved" title={activeTab.filePath ?? undefined}>
                <HardDrive size={9} />
                {shortPath}
              </span>
            ) : (
              <span className="status-item">In memory</span>
            )}

            <span className="status-tag">
              {activeTab.kind === "whiteboard"
                ? "Whiteboard"
                : (MODE_LABEL[activeTab.editorMode] ?? activeTab.editorMode)}
            </span>
          </>
        )}
        <span className="status-item" style={{ textTransform: "capitalize" }}>{themeId}</span>

        <span className="status-separator" />
        <span className="status-item status-brand">
          {APP_NAME} v{APP_VERSION} &mdash; by TrexoLab
        </span>
      </div>
    </div>
  );
});
