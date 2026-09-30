import React, { useCallback, useEffect, useRef, useState } from "react";
import { useEscapeKey } from "../../../hooks/useEscapeKey";
import {
  loadConversations, saveConversation, deleteConversation, clearConversations,
  type ChatConversation,
} from "../../../lib/ai/chatHistory";
import type { Msg } from "./types";

// crypto.randomUUID is available in the Tauri webview.
export const newId = () => crypto.randomUUID();

/**
 * Saved-conversation list + the History drawer's open state. `messages`/`busy`
 * come from useChatStream — persistence only fires once a stream settles,
 * matching the original effect exactly. `setMessages` lets remove/clear reset
 * the active conversation when it's the one being deleted.
 */
export function useChatHistory(messages: Msg[], busy: boolean, setMessages: (m: Msg[]) => void) {
  const [conversations, setConversations] = useState<ChatConversation[]>(() => loadConversations());
  const [historyOpen, setHistoryOpen] = useState(false);
  const convIdRef = useRef<string>(newId());      // id of the conversation being edited
  const nowRef = useRef<number>(Date.now());

  // Persist the current conversation whenever it settles (not mid-stream).
  useEffect(() => {
    if (busy) return;
    if (messages.length === 0) return;
    const list = saveConversation(convIdRef.current, messages, Date.now());
    setConversations(list);
  }, [busy, messages]);

  // Esc closes the history drawer when it's open.
  useEscapeKey(() => setHistoryOpen(false), historyOpen);

  const removeChat = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const list = deleteConversation(id);
    setConversations(list);
    if (id === convIdRef.current) { convIdRef.current = newId(); setMessages([]); }
  }, [setMessages]);

  const clearAllHistory = useCallback(() => {
    setConversations(clearConversations());
    convIdRef.current = newId();
    setMessages([]);
    setHistoryOpen(false);
  }, [setMessages]);

  return {
    conversations, historyOpen, setHistoryOpen, convIdRef, nowRef,
    removeChat, clearAllHistory,
  };
}

export type { ChatConversation };
