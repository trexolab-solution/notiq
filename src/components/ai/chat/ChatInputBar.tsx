import React from "react";
import { Send, Square } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";

interface ChatInputBarProps {
  inputRef: React.RefObject<HTMLTextAreaElement>;
  input: string;
  onInputChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  busy: boolean;
  onSend: () => void;
  onStop: () => void;
}

/** The composer's textarea + send/stop button. */
export function ChatInputBar({ inputRef, input, onInputChange, onKeyDown, busy, onSend, onStop }: ChatInputBarProps) {
  return (
    <div className="ai-chat__inputwrap">
      <textarea
        ref={inputRef}
        className="ai-chat__input"
        placeholder="Ask anything…  (Enter to send, Shift+Enter for newline)"
        value={input}
        rows={1}
        spellCheck={false}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {busy ? (
        <Tooltip content="Stop generating">
          <button className="ai-chat__send is-stop" aria-label="Stop" onClick={onStop}><Square size={14} /></button>
        </Tooltip>
      ) : (
        <Tooltip content="Send" shortcut="Enter">
          <button className="ai-chat__send" aria-label="Send" onClick={onSend} disabled={!input.trim()}><Send size={14} /></button>
        </Tooltip>
      )}
    </div>
  );
}
