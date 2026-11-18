import { FolderInput, Star, StarOff, Tags, Trash2, X } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";

interface Props {
  count: number;
  onStar: (starred: boolean) => void;
  onTags: () => void;
  onMove: () => void;
  onTrash: () => void;
  onClear: () => void;
}

/** Shown above the list while rows are ticked: what the ticked entries can do all at once. */
export function BulkBar({ count, onStar, onTags, onMove, onTrash, onClear }: Props) {
  const btn = (label: string, icon: JSX.Element, onClick: () => void, danger = false) => (
    <Tooltip content={label}>
      <button type="button" className="vt-icon-btn" aria-label={`${label} (${count} selected)`} onClick={onClick}
              style={danger ? { color: "var(--color-danger)" } : undefined}>
        {icon}
      </button>
    </Tooltip>
  );
  return (
    <div className="vt-bulk" role="toolbar" aria-label="Actions for the selected entries">
      <span className="vt-bulk-count" role="status" aria-live="polite">{count} selected</span>
      {btn("Star", <Star size={13} />, () => onStar(true))}
      {btn("Remove star", <StarOff size={13} />, () => onStar(false))}
      {btn("Add tags…", <Tags size={13} />, onTags)}
      {btn("Move to…", <FolderInput size={13} />, onMove)}
      {btn("Move to Trash", <Trash2 size={13} />, onTrash, true)}
      {btn("Clear selection", <X size={13} />, onClear)}
    </div>
  );
}
