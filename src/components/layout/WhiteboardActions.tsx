import { FileText } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../store";
import type { Tab } from "../../types";

export function WhiteboardActions({ tab }: { tab: Tab }) {
  const tabs         = useAppStore((s) => s.tabs);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const note = tabs.find((t) => t.id === tab.linkedNoteId);
  if (!note) return null;

  return (
    <div className="tab-bar-actions">
      <Tooltip content={`Go to "${note.title}"`}>
        <button
          className="header-icon-btn header-icon-btn--with-label"
          onClick={() => setActiveTab(note.id)}
        >
          <FileText size={13} strokeWidth={1.8} />
          <span className="header-icon-btn-label">{note.title}</span>
        </button>
      </Tooltip>
    </div>
  );
}
