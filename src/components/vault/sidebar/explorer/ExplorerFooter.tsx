import { Trash2 } from "lucide-react";
import { Tooltip } from "../../../ui/Tooltip";

/** The footer rows: Recently synced (when sync brought changes), Trash. */
export function ExplorerFooter({ syncedCount, showReview, onToggleReview, showTrash, onToggleTrash, trashCount }: {
  syncedCount: number;
  showReview: boolean;
  onToggleReview: () => void;
  showTrash: boolean;
  onToggleTrash: () => void;
  trashCount: number;
}) {
  return (
    <div className="vt-footer">
      {/* Announced once per change of the count (screen readers); the row below is the visible part. */}
      <span className="sr-only" role="status" aria-live="polite">
        {syncedCount > 0 ? `${syncedCount} item${syncedCount === 1 ? "" : "s"} changed by sync` : ""}
      </span>
      {syncedCount > 0 && (
        <Tooltip content="Items sync brought in from Google Drive" description="Opening an item marks it as seen" placement="top">
          <button
            type="button"
            className={`vt-footer-row${showReview ? " is-active" : ""}`}
            aria-pressed={showReview}
            onClick={onToggleReview}
          >
            <span className="vt-sync-dot" aria-hidden /> Recently synced
            <span className="vt-count">{syncedCount}</span>
          </button>
        </Tooltip>
      )}
      <Tooltip content="Deleted items are kept for 30 days" placement="top">
        <button
          type="button"
          className={`vt-footer-row${showTrash ? " is-active" : ""}`}
          aria-pressed={showTrash}
          onClick={onToggleTrash}
        >
          <Trash2 size={13} aria-hidden /> Trash
          {trashCount > 0 && <span className="vt-count">{trashCount}</span>}
        </button>
      </Tooltip>
    </div>
  );
}
