import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { AlertTriangle, Check, Copy, CornerDownLeft, Info, RotateCcw } from "lucide-react";
import { Tooltip } from "../../ui/Tooltip";
import type { Msg } from "./types";

interface ChatMessageBubbleProps {
  message: Msg;
  index: number;
  mdComponents: Components;
  copiedIdx: number | null;
  busy: boolean;
  onCopy: (content: string, idx: number) => void;
  onInsert: (content: string) => void;
  onRegenerate: (idx: number) => void;
}

/**
 * A single chat turn: its optional fallback/length-cutoff note, the markdown
 * body (or a typing indicator while still streaming), and the Copy/Insert/
 * Regenerate action row once the reply has settled.
 */
export function ChatMessageBubble({
  message, index, mdComponents, copiedIdx, busy, onCopy, onInsert, onRegenerate,
}: ChatMessageBubbleProps) {
  const isStreaming = message.role === "assistant" && !message.content;
  const isError = message.content.startsWith("⚠️");
  const showActions = !isStreaming && !isError;

  return (
    <div className={`ai-chat__msg ai-chat__msg--${message.role}`}>
      {message.note && (
        <div className={`ai-chat__note ai-chat__note--${message.noteTone ?? "info"}`}>
          {message.noteTone === "warning" ? <AlertTriangle size={11} /> : <Info size={11} />}
          <span>{message.note}</span>
        </div>
      )}
      <div className={`ai-chat__bubble${isError ? " is-error" : ""}`}>
        {isStreaming ? (
          <span className="ai-chat__typing"><span></span><span></span><span></span></span>
        ) : (
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>{message.content}</ReactMarkdown>
        )}
      </div>
      {showActions && (
        <div className="ai-chat__actions">
          <Tooltip content={copiedIdx === index ? "Copied" : "Copy"}>
            <button className="ai-chat__action" aria-label="Copy" onClick={() => onCopy(message.content, index)}>
              {copiedIdx === index ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </Tooltip>
          {message.role === "assistant" && (
            <>
              <Tooltip content="Insert into note">
                <button className="ai-chat__action" aria-label="Insert into note" onClick={() => onInsert(message.content)}>
                  <CornerDownLeft size={13} />
                </button>
              </Tooltip>
              <Tooltip content="Regenerate">
                <button className="ai-chat__action" aria-label="Regenerate" onClick={() => onRegenerate(index)} disabled={busy}>
                  <RotateCcw size={13} />
                </button>
              </Tooltip>
            </>
          )}
        </div>
      )}
    </div>
  );
}
