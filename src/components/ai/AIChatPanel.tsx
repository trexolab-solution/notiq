import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../store";
import type { ChatConversation } from "../../lib/ai/chatHistory";
import { ChatHeader } from "./chat/ChatHeader";
import { ChatHistoryDrawer } from "./chat/ChatHistoryDrawer";
import { ChatMessageList } from "./chat/ChatMessageList";
import { ChatContextBar } from "./chat/ChatContextBar";
import { ChatInputBar } from "./chat/ChatInputBar";
import { useContextFiles } from "./chat/useContextFiles";
import { useChatModels } from "./chat/useChatModels";
import { useAutoScroll } from "./chat/useAutoScroll";
import { useChatStream } from "./chat/useChatStream";
import { useChatHistory, newId } from "./chat/useChatHistory";
import { useMessageActions } from "./chat/useMessageActions";

interface Props {
  onClose: () => void;
}

export const AIChatPanel = React.memo(function AIChatPanel({ onClose }: Props) {
  const aiEnabled  = useAppStore((s) => s.aiEnabled);
  const aiProvider = useAppStore((s) => s.aiProvider);
  const aiModel    = useAppStore((s) => s.aiModel);

  const [input, setInput] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    useNoteContext, toggleNoteContext,
    noteTabs, contextTabIds, selectedTabs,
    toggleContextTab, selectAllContext, clearAllContext, resetContextTabs,
    ctxPopoverOpen, setCtxPopoverOpen, ctxPickerBtnRef,
  } = useContextFiles();

  const {
    modelOverride, modelChoices, loadModelChoices,
    modelExtraOptions, modelSelectValue, onModelSelectChange, resetModelOverride,
  } = useChatModels(aiProvider, aiModel);

  const { scrollRef, pinned, setPinned, scrollToBottom, scrollIfPinned } = useAutoScroll();

  const { messages, setMessages, busy, stop, send, regenerate } = useChatStream({
    aiEnabled, aiProvider, aiModel, modelOverride, useNoteContext, contextTabIds, setPinned,
  });

  // Auto-scroll to bottom as messages grow — but only while pinned, so
  // scrolling up mid-stream to re-read something isn't yanked back down.
  useEffect(() => { scrollIfPinned(); }, [messages, scrollIfPinned]);

  const { conversations, historyOpen, setHistoryOpen, convIdRef, nowRef, removeChat, clearAllHistory } =
    useChatHistory(messages, busy, setMessages);

  const { mdComponents, copiedIdx, copyMsg, insertToNote } = useMessageActions();

  // Auto-grow the composer textarea with its content (capped via CSS max-height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const handleSend = useCallback(() => {
    if (send(input)) setInput("");
  }, [send, input]);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }, [handleSend]);

  // ── History actions ─────────────────────────────────────────────────────────
  const startNewChat = useCallback(() => {
    stop();
    convIdRef.current = newId();
    setMessages([]);
    resetModelOverride();
    resetContextTabs();
    setPinned(true);
    setHistoryOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [stop, convIdRef, setMessages, resetModelOverride, resetContextTabs, setPinned, setHistoryOpen]);

  const loadChat = useCallback((c: ChatConversation) => {
    stop();
    convIdRef.current = c.id;
    setMessages(c.messages);
    resetModelOverride();
    resetContextTabs();
    setPinned(true);
    setHistoryOpen(false);
  }, [stop, convIdRef, setMessages, resetModelOverride, resetContextTabs, setPinned, setHistoryOpen]);

  return (
    <div className="ai-chat">
      <ChatHeader
        historyOpen={historyOpen}
        onNewChat={startNewChat}
        onToggleHistory={() => setHistoryOpen((v) => !v)}
        onClose={onClose}
      />

      {historyOpen && (
        <ChatHistoryDrawer
          conversations={conversations}
          currentId={convIdRef.current}
          now={nowRef.current}
          onLoad={loadChat}
          onRemove={removeChat}
          onClearAll={clearAllHistory}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      <ChatMessageList
        messages={messages}
        useNoteContext={useNoteContext}
        scrollRef={scrollRef}
        pinned={pinned}
        mdComponents={mdComponents}
        copiedIdx={copiedIdx}
        busy={busy}
        onCopy={copyMsg}
        onInsert={insertToNote}
        onRegenerate={regenerate}
        onJumpToLatest={() => { scrollToBottom(true); setPinned(true); }}
      />

      <div className="ai-chat__composer">
        <ChatContextBar
          useNoteContext={useNoteContext}
          onToggleNoteContext={toggleNoteContext}
          selectedTabs={selectedTabs}
          noteTabs={noteTabs}
          contextTabIds={contextTabIds}
          onToggleContextTab={toggleContextTab}
          onSelectAllContext={selectAllContext}
          onClearAllContext={clearAllContext}
          ctxPopoverOpen={ctxPopoverOpen}
          onToggleCtxPopover={(e) => { e.stopPropagation(); setCtxPopoverOpen((v) => !v); }}
          onCloseCtxPopover={() => setCtxPopoverOpen(false)}
          ctxPickerBtnRef={ctxPickerBtnRef}
          modelSelectValue={modelSelectValue}
          onModelSelectChange={onModelSelectChange}
          loadModelChoices={loadModelChoices}
          modelChoices={modelChoices}
          modelExtraOptions={modelExtraOptions}
        />

        <ChatInputBar
          inputRef={inputRef}
          input={input}
          onInputChange={setInput}
          onKeyDown={onKeyDown}
          busy={busy}
          onSend={handleSend}
          onStop={stop}
        />
      </div>
    </div>
  );
});
