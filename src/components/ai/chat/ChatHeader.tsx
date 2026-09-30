import { History, Plus, Sparkles, X } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";

interface ChatHeaderProps {
  historyOpen: boolean;
  onNewChat: () => void;
  onToggleHistory: () => void;
  onClose: () => void;
}

/** Fixed top bar: title + New chat / History / Close actions. */
export function ChatHeader({ historyOpen, onNewChat, onToggleHistory, onClose }: ChatHeaderProps) {
  return (
    <div className="ai-chat__header">
      <span className="ai-chat__title"><Sparkles size={13} /> AI Chat</span>
      <div className="ai-chat__header-actions">
        <Tooltip content="New chat">
          <button className="ai-chat__icon-btn" aria-label="New chat" onClick={onNewChat}>
            <Plus size={15} />
          </button>
        </Tooltip>
        <Tooltip content="History">
          <button
            className={`ai-chat__icon-btn${historyOpen ? " is-active" : ""}`}
            aria-label="History"
            onClick={onToggleHistory}
          >
            <History size={14} />
          </button>
        </Tooltip>
        <Tooltip content="Close">
          <button className="ai-chat__icon-btn" aria-label="Close" onClick={onClose}><X size={15} /></button>
        </Tooltip>
      </div>
    </div>
  );
}
