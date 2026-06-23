import React from "react";
import { Settings, GitBranch, PenTool, FileText } from "lucide-react";
import { useAppStore } from "../../store";
import { Tooltip } from "../ui/Tooltip";
import type { AppView } from "../../types";

export type { AppView };

interface SidebarProps {
  activeView: AppView;
  onViewChange: (v: AppView) => void;
  onNewWhiteboard: () => void;
  onOpenSettings: () => void;
}

export const Sidebar = React.memo(function Sidebar({
  activeView, onViewChange, onNewWhiteboard, onOpenSettings,
}: SidebarProps) {
  const tabs        = useAppStore((s) => s.tabs);
  const activeTabId = useAppStore((s) => s.activeTabId);
  const isWbActive  = tabs.find((t) => t.id === activeTabId)?.kind === "whiteboard";

  return (
    <aside style={{ display: "flex", height: "100%", flexShrink: 0 }}>
      <div className="activity-bar">
        <Tooltip content="Editor" shortcut="Ctrl+1">
          <button
            className={`activity-btn${activeView === "editor" ? " is-active" : ""}`}
            aria-label="Editor"
            onClick={() => onViewChange("editor")}
          >
            <FileText size={17} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <Tooltip content="Knowledge Graph" shortcut="Ctrl+2">
          <button
            className={`activity-btn${activeView === "graph" ? " is-active" : ""}`}
            aria-label="Knowledge Graph"
            onClick={() => onViewChange("graph")}
          >
            <GitBranch size={17} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <Tooltip content="Whiteboard" shortcut="Ctrl+3">
          <button
            className={`activity-btn${isWbActive ? " is-active" : ""}`}
            aria-label="Whiteboard"
            onClick={onNewWhiteboard}
          >
            <PenTool size={17} strokeWidth={1.8} />
          </button>
        </Tooltip>

        <div style={{ flex: 1 }} />

        <Tooltip content="Settings" shortcut="Ctrl+,">
          <button className="activity-btn" aria-label="Settings" onClick={onOpenSettings}>
            <Settings size={15} strokeWidth={1.8} />
          </button>
        </Tooltip>
      </div>
    </aside>
  );
});
