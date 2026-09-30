import React from "react";
import type { Components } from "react-markdown";
import { ArrowDown, Sparkles } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
import type { Msg } from "./types";
import { ChatMessageBubble } from "./ChatMessageBubble";

interface ChatMessageListProps {
  messages: Msg[];
  useNoteContext: boolean;
  scrollRef: React.RefObject<HTMLDivElement>;
  pinned: boolean;
  mdComponents: Components;
  copiedIdx: number | null;
  busy: boolean;
  onCopy: (content: string, idx: number) => void;
  onInsert: (content: string) => void;
  onRegenerate: (idx: number) => void;
  onJumpToLatest: () => void;
}

/**
 * The scrollable message history (with its own empty state) plus the
 * "jump to latest" button that appears once the user has scrolled away from
 * the bottom mid-conversation. Kept together since both are driven by the
 * same autoscroll/`pinned` state.
 */
export function ChatMessageList({
  messages, useNoteContext, scrollRef, pinned, mdComponents, copiedIdx, busy,
  onCopy, onInsert, onRegenerate, onJumpToLatest,
}: ChatMessageListProps) {
  return (
    <>
      <div className="ai-chat__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-chat__empty">
            <Sparkles size={22} strokeWidth={1.5} />
            <p>Ask anything</p>
            <span>{useNoteContext ? "Open notes/files can be shared as context." : "Note context is off — ask freely."}</span>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessageBubble
            key={i}
            message={m}
            index={i}
            mdComponents={mdComponents}
            copiedIdx={copiedIdx}
            busy={busy}
            onCopy={onCopy}
            onInsert={onInsert}
            onRegenerate={onRegenerate}
          />
        ))}
      </div>

      {!pinned && messages.length > 0 && (
        <Tooltip content="Jump to latest">
          <button
            type="button"
            className="ai-chat__jump-btn"
            aria-label="Jump to latest message"
            onClick={onJumpToLatest}
          >
            <ArrowDown size={13} />
          </button>
        </Tooltip>
      )}
    </>
  );
}
