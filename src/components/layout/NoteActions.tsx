import { useMemo } from "react";
import { PenTool } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../store";
import type { Tab } from "../../types";

interface Props {
  tab: Tab;
  onLinkedWhiteboard: () => void;
}

function countWords(content: string) {
  return content
    .replace(/```[\s\S]*?```/g, " ").replace(/`[^`]+`/g, " ")
    .replace(/#{1,6}\s/g, "").replace(/[*_~[\]()>]/g, "")
    .trim().split(/\s+/).filter(Boolean).length;
}

export function NoteActions({ tab, onLinkedWhiteboard }: Props) {
  const tabs = useAppStore((s) => s.tabs);

  const wordCount = useMemo(() => countWords(tab.content), [tab.content]);
  const linkedWhiteboard = tabs.find(
    (t) => t.kind === "whiteboard" && t.linkedNoteId === tab.id,
  );

  return (
    <div className="tab-bar-actions">
      {wordCount > 0 && (
        <span className="header-meta">{wordCount.toLocaleString()}w</span>
      )}

      <Tooltip
        content={linkedWhiteboard ? "Open linked whiteboard" : "Create linked whiteboard"}
      >
        <button
          className="header-icon-btn"
          onClick={onLinkedWhiteboard}
          style={linkedWhiteboard ? { color: "var(--color-primary)" } : undefined}
        >
          <PenTool size={13} strokeWidth={1.8} />
        </button>
      </Tooltip>
    </div>
  );
}
