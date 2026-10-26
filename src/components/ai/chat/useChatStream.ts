import { useCallback, useEffect, useRef, useState } from "react";
import {
  aiCompleteStream, type ChatMessage, type StreamHandle,
} from "../../../lib/ai/client";
import { chatSystem } from "../../../lib/ai/prompts";
import { mapAiError } from "../../../lib/ai/errors";
import { toast } from "../../../lib/toast";
import { useAppStore } from "../../../store";
import { isVaultPath } from "../../../lib/vault";
import type { AIProvider } from "../../../types";
import { tabToContextFile } from "./contextFiles";
import { MAX_NOTE_CHARS, MAX_TOTAL_CONTEXT_CHARS, PROVIDER_TAG, type Msg } from "./types";
import type { ModelOverride } from "./useChatModels";

interface UseChatStreamParams {
  aiEnabled: boolean;
  aiProvider: AIProvider;
  aiModel: string;
  modelOverride: ModelOverride | null;
  useNoteContext: boolean;
  contextTabIds: Set<string>;
  /** Re-pin the message list to the bottom — called on send/regenerate, same as
   *  the original inline `setPinned(true)` calls. */
  setPinned: (pinned: boolean) => void;
}

/**
 * Owns the conversation's messages, the in-flight stream, and the send/stop/
 * regenerate actions that drive it. Extracted from AIChatPanel's `runCompletion`
 * + friends as-is — the context-file gathering, fallback/length-cutoff notes,
 * and error handling all match the original behavior exactly.
 */
export function useChatStream({
  aiEnabled, aiProvider, aiModel, modelOverride, useNoteContext, contextTabIds, setPinned,
}: UseChatStreamParams) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<StreamHandle | null>(null);

  useEffect(() => () => { streamRef.current?.cancel(); }, []);

  const stop = useCallback(() => {
    streamRef.current?.cancel();
    streamRef.current = null;
    setBusy(false);
    // Drop a still-empty assistant bubble (the typing placeholder); keep any
    // partial text that already streamed in.
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && !last.content) return prev.slice(0, -1);
      return prev;
    });
  }, []);

  // Stream an assistant reply for the given conversation history. Appends a fresh
  // empty assistant bubble and fills it token-by-token. Shared by send + regenerate.
  const runCompletion = useCallback((history: Msg[]) => {
    if (!aiEnabled) { toast.warning("AI is off — turn it on in Settings → AI"); return; }
    const provider = modelOverride?.provider ?? aiProvider;
    const model = modelOverride?.model ?? aiModel;
    if (!model)     { toast.warning("Pick a model in Settings → AI"); return; }

    // Grab the checked context tabs for grounding (only when the toggle is on).
    // Total content is capped across all of them, split proportionally so N
    // files never blows the prompt past MAX_TOTAL_CONTEXT_CHARS.
    const st = useAppStore.getState();
    const activeTabs = useNoteContext
      // Defense in depth: even if a vault tab id slipped into the selection, never send it.
      ? st.tabs.filter((t) => t.kind === "note" && !isVaultPath(t.filePath) && contextTabIds.has(t.id))
      : [];
    const perFileCap = activeTabs.length > 0
      ? Math.min(MAX_NOTE_CHARS, Math.floor(MAX_TOTAL_CONTEXT_CHARS / activeTabs.length))
      : MAX_NOTE_CHARS;
    const contextFiles = activeTabs.map((t) => tabToContextFile(t, perFileCap));

    setMessages([...history, { role: "assistant", content: "" }]);
    setBusy(true);

    const apiMessages: ChatMessage[] = [
      { role: "system", content: chatSystem(contextFiles) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const handle = aiCompleteStream(
      apiMessages,
      {
        maxTokens: 4096, temperature: 0.4, provider, model,
        onFallback: (fb) => {
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") {
              next[next.length - 1] = {
                ...last,
                note: `Switched to ${PROVIDER_TAG[fb.provider]} (${fb.model}) after an auth/quota error`,
                noteTone: "info",
              };
            }
            return next;
          });
        },
      },
      {
        onToken: (tok) => {
          setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.role === "assistant") next[next.length - 1] = { ...last, content: last.content + tok };
            return next;
          });
        },
        onComplete: (finishReason) => {
          streamRef.current = null;
          setBusy(false);
          // Cut off by the token cap → note it so the user knows to ask to continue.
          if (finishReason === "length") {
            setMessages((prev) => {
              const next = prev.slice();
              const last = next[next.length - 1];
              if (last && last.role === "assistant" && last.content) {
                next[next.length - 1] = {
                  ...last,
                  note: 'Response was cut off (length limit) — type "continue" to get the rest.',
                  noteTone: "warning",
                };
              }
              return next;
            });
          }
        },
      },
    );
    streamRef.current = handle;
    handle.done.catch((e) => {
      streamRef.current = null;
      setBusy(false);
      const errMsg = mapAiError(e);
      setMessages((prev) => {
        const next = prev.slice();
        const last = next[next.length - 1];
        if (last && last.role === "assistant" && !last.content) next[next.length - 1] = { ...last, content: `⚠️ ${errMsg}` };
        return next;
      });
    });
  }, [aiEnabled, aiProvider, aiModel, modelOverride, useNoteContext, contextTabIds]);

  // Sends `text` as a new user turn. Returns whether it actually queued a
  // completion, so the caller (the composer) only clears its input on success.
  const send = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (!trimmed || busy) return false;
    setPinned(true);
    runCompletion([...messages, { role: "user", content: trimmed }]);
    return true;
  }, [busy, messages, runCompletion, setPinned]);

  // Re-run the conversation up to (and including) the user turn that produced the
  // assistant message at `assistantIdx`, replacing that assistant reply.
  const regenerate = useCallback((assistantIdx: number) => {
    if (busy) return;
    const history = messages.slice(0, assistantIdx); // everything before this reply
    if (history.length === 0) return;
    setPinned(true);
    runCompletion(history);
  }, [busy, messages, runCompletion, setPinned]);

  return { messages, setMessages, busy, stop, send, regenerate };
}
