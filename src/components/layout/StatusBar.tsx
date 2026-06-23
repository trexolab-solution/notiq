import React, { useMemo } from "react";
import { HardDrive, SquareTerminal } from "lucide-react";
import { useAppStore } from "../../store";
import { Tooltip } from "../ui/Tooltip";
import { APP_NAME, APP_VERSION } from "../../config/app";

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

      {/* Right: save state + mode + theme */}
      <div className="status-group">
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
