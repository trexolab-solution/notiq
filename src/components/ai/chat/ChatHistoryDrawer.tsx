import React from "react";
import { Trash2 } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
import { relativeTime, type ChatConversation } from "../../../lib/ai/chatHistory";

interface ChatHistoryDrawerProps {
  conversations: ChatConversation[];
  /** Id of the conversation currently being edited (highlights its row). */
  currentId: string;
  /** Timestamp baseline for relative-time labels (stable per panel mount). */
  now: number;
  onLoad: (c: ChatConversation) => void;
  onRemove: (id: string, e: React.MouseEvent) => void;
  onClearAll: () => void;
  onClose: () => void;
}

/** Backdrop + recent-chats list, opened from the header's History button. */
export function ChatHistoryDrawer({
  conversations, currentId, now, onLoad, onRemove, onClearAll, onClose,
}: ChatHistoryDrawerProps) {
  return (
    <div className="ai-chat__history-backdrop" onMouseDown={onClose}>
      <div className="ai-chat__history" onMouseDown={(e) => e.stopPropagation()}>
        <div className="ai-chat__history-head">
          <span>Recent chats</span>
          {conversations.length > 0 && (
            <button className="ai-chat__history-clear" onClick={onClearAll}>Clear all</button>
          )}
        </div>
        {conversations.length === 0 ? (
          <div className="ai-chat__history-empty">No saved chats yet</div>
        ) : (
          <ul className="ai-chat__history-list">
            {conversations.map((c) => (
              <li
                key={c.id}
                className={`ai-chat__history-item${c.id === currentId ? " is-current" : ""}`}
                onClick={() => onLoad(c)}
              >
                <span className="ai-chat__history-title">{c.title}</span>
                <span className="ai-chat__history-time">{relativeTime(c.updatedAt, now)}</span>
                <Tooltip content="Delete">
                  <button className="ai-chat__history-del" aria-label="Delete chat" onClick={(e) => onRemove(c.id, e)}>
                    <Trash2 size={12} />
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
