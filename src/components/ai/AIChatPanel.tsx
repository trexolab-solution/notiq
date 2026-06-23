import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { X, Send, Square, Trash2, CornerDownLeft, Sparkles, Copy, Check, RotateCcw, FileText, History, Plus, FilePlus2 } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../../store";
import { aiCompleteStream, type ChatMessage, type StreamHandle } from "../../lib/ai/client";
import { chatSystem } from "../../lib/ai/prompts";
import { mapAiError } from "../../lib/ai/errors";
import { getActiveEditor } from "../../lib/activeEditor";
import { insertAtCursor } from "../../lib/ai/actions";
import { resolveCodeLang } from "../../lib/ai/codeLang";
import { getLanguageFromPath, isMarkdownLike } from "../../lib/language";
import { getFileName } from "../../lib/pathUtils";
import { scoreRelevance, relevanceLabel } from "../../lib/ai/relevance";
import { toast } from "../../lib/toast";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Tooltip } from "../ui/Tooltip";
import {
  loadConversations, saveConversation, deleteConversation, clearConversations,
  relativeTime, type ChatConversation,
} from "../../lib/ai/chatHistory";

interface Msg { role: "user" | "assistant"; content: string; }

const MAX_NOTE_CHARS = 8000;

// crypto.randomUUID is available in the Tauri webview.
const newId = () => crypto.randomUUID();

/** Flatten a React node tree to its plain-text content (for copying code). */
function nodeText(node: React.ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return "";
}

/**
 * Wraps a fenced code block (already syntax-highlighted by rehype-highlight) with
 * a header bar: language label + Copy + Insert-into-note. `children` is the
 * highlighted <code> element from react-markdown; `code` is its plain text.
 */
function CodeBlock({ code, lang, onInsert, onNewFile, children }: {
  code: string; lang: string;
  onInsert: (c: string) => void;
  onNewFile: (c: string, lang: string) => void;
  children: React.ReactNode;
}) {
  const { copied, copy } = useCopyToClipboard(1500);
  const doCopy = () => {
    copy(code).then((ok) => { if (!ok) toast.error("Couldn't copy"); });
  };
  return (
    <div className="ai-code">
      <div className="ai-code__head">
        <span className="ai-code__lang">{lang || "code"}</span>
        <div className="ai-code__actions">
          <Tooltip content={copied ? "Copied" : "Copy code"}>
            <button className="ai-code__btn" aria-label="Copy code" onClick={doCopy}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </Tooltip>
          <Tooltip content="Open this code as a new file/tab">
            <button className="ai-code__btn" aria-label="Open code as new file" onClick={() => onNewFile(code, lang)}>
              <FilePlus2 size={12} /><span>New file</span>
            </button>
          </Tooltip>
          <Tooltip content="Insert this code into the active note">
            <button className="ai-code__btn" aria-label="Insert code into note" onClick={() => onInsert(code)}>
              <CornerDownLeft size={12} /><span>Insert</span>
            </button>
          </Tooltip>
        </div>
      </div>
      <pre className="ai-code__pre">{children}</pre>
    </div>
  );
}

interface Props {
  onClose: () => void;
}

export const AIChatPanel = React.memo(function AIChatPanel({ onClose }: Props) {
  const aiEnabled = useAppStore((s) => s.aiEnabled);
  const aiModel   = useAppStore((s) => s.aiModel);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [useNoteContext, setUseNoteContext] = useState(
    () => localStorage.getItem("pref:aiChatUseNoteContext") !== "false",
  );

  // History
  const [conversations, setConversations] = useState<ChatConversation[]>(() => loadConversations());
  const [historyOpen, setHistoryOpen] = useState(false);
  const convIdRef = useRef<string>(newId());      // id of the conversation being edited
  const nowRef = useRef<number>(Date.now());

  // Live label for the context pill — filename for real files, title for notes.
  const activeNoteTitle = useAppStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (!tab || tab.kind !== "note") return null;
    if (tab.filePath) return getFileName(tab.filePath); // real file → show its name+ext
    return tab.title;                                   // in-memory note → its title
  });
  // Active note content, so the pill can preview how relevant it is to the draft.
  const activeNoteContent = useAppStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab && tab.kind === "note" ? tab.content : "";
  });

  const streamRef = useRef<StreamHandle | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef  = useRef<HTMLTextAreaElement>(null);

  const toggleNoteContext = useCallback(() => {
    setUseNoteContext((v) => {
      const next = !v;
      localStorage.setItem("pref:aiChatUseNoteContext", String(next));
      return next;
    });
  }, []);

  // Auto-scroll to bottom as messages grow.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Auto-grow the composer textarea with its content (capped via CSS max-height).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // Persist the current conversation whenever it settles (not mid-stream).
  useEffect(() => {
    if (busy) return;
    if (messages.length === 0) return;
    const list = saveConversation(convIdRef.current, messages, Date.now());
    setConversations(list);
  }, [busy, messages]);

  useEffect(() => () => { streamRef.current?.cancel(); }, []);

  // Esc closes the history drawer when it's open.
  useEscapeKey(() => setHistoryOpen(false), historyOpen);

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
    if (!aiModel)   { toast.warning("Pick a model in Settings → AI"); return; }

    // Grab the active note/file for grounding (only when the toggle is on).
    const st = useAppStore.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    const useTab = useNoteContext && tab && tab.kind === "note";

    // File-type awareness: if the active tab is a real (non-markdown) file, tell
    // the AI its filename + language so it answers in that language, not prose.
    let fileName: string | undefined;
    let language: string | undefined;
    if (useTab) {
      // Prefer an explicit per-tab language (AI snippet tabs), else derive from path.
      const lang = tab.language ?? getLanguageFromPath(tab.filePath);
      const isProseNote = !tab.filePath || (isMarkdownLike(tab.filePath) && !tab.language);
      if (!isProseNote) {
        language = lang;
        fileName = tab.filePath ? getFileName(tab.filePath) : tab.title;
      }
    }

    const noteTitle = useTab && tab.title !== "Untitled" ? tab.title : undefined;
    const noteContent = useTab ? tab.content.slice(0, MAX_NOTE_CHARS) : undefined;

    // How related is the open document to this request? Gates context usage.
    const lastUser = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
    const relevance = noteContent ? scoreRelevance(lastUser, noteContent) : "low";

    setMessages([...history, { role: "assistant", content: "" }]);
    setBusy(true);

    const apiMessages: ChatMessage[] = [
      { role: "system", content: chatSystem(noteTitle, noteContent, fileName, language, relevance) },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ];

    const handle = aiCompleteStream(
      apiMessages,
      { maxTokens: 4096, temperature: 0.4 },
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
          // Cut off by the token cap → append a hint so the user can ask to continue.
          if (finishReason === "length") {
            setMessages((prev) => {
              const next = prev.slice();
              const last = next[next.length - 1];
              if (last && last.role === "assistant" && last.content) {
                next[next.length - 1] = { ...last, content: `${last.content}\n\n_⚠️ Response was cut off (length limit). Type "continue" to get the rest._` };
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
  }, [aiEnabled, aiModel, useNoteContext]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    runCompletion([...messages, { role: "user", content: text }]);
  }, [input, busy, messages, runCompletion]);

  // Re-run the conversation up to (and including) the user turn that produced the
  // assistant message at `assistantIdx`, replacing that assistant reply.
  const regenerate = useCallback((assistantIdx: number) => {
    if (busy) return;
    const history = messages.slice(0, assistantIdx); // everything before this reply
    if (history.length === 0) return;
    runCompletion(history);
  }, [busy, messages, runCompletion]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const insertToNote = useCallback((content: string) => {
    const ed = getActiveEditor();
    if (!ed) { toast.warning("Open a note first"); return; }
    insertAtCursor(ed, content, "ai-chat-insert");
    toast.success("Inserted into note");
  }, []);

  // Live relevance of the open note to the current draft — shown on the pill so
  // the user knows whether the context will actually be used.
  const liveRelevance = useMemo(
    () => (useNoteContext && input.trim() && activeNoteContent.trim()
      ? scoreRelevance(input, activeNoteContent)
      : null),
    [useNoteContext, input, activeNoteContent],
  );

  // Open a code block as a new unsaved tab in the right language.
  const newFileFromCode = useCallback((code: string, fenceLang: string) => {
    const { lang, ext } = resolveCodeLang(fenceLang, code);
    useAppStore.getState().addTab({
      title: `snippet.${ext}`,
      content: code,
      language: lang,
      editorMode: "markdown", // source view (no md preview for code)
    });
    toast.success(`Opened as snippet.${ext}`);
  }, []);

  // Custom markdown renderers: fenced code blocks get a header (lang + Copy + New file + Insert).
  const mdComponents = useMemo<Components>(() => ({
    pre({ children }) {
      // The single child is the <code> element produced by react-markdown.
      const child = Array.isArray(children) ? children[0] : children;
      const props = React.isValidElement(child)
        ? (child.props as { className?: string; children?: React.ReactNode })
        : undefined;
      const className: string = props?.className ?? "";
      const m = /language-(\w+)/.exec(className);
      const lang = m ? m[1] : "";
      const code = nodeText(props?.children).replace(/\n$/, "");
      return <CodeBlock code={code} lang={lang} onInsert={insertToNote} onNewFile={newFileFromCode}>{child}</CodeBlock>;
    },
  }), [insertToNote, newFileFromCode]);

  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const copyMsg = useCallback((content: string, idx: number) => {
    writeText(content)
      .then(() => {
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
      })
      .catch(() => toast.error("Couldn't copy"));
  }, []);

  // ── History actions ─────────────────────────────────────────────────────────
  const startNewChat = useCallback(() => {
    stop();
    convIdRef.current = newId();
    setMessages([]);
    setHistoryOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [stop]);

  const loadChat = useCallback((c: ChatConversation) => {
    stop();
    convIdRef.current = c.id;
    setMessages(c.messages);
    setHistoryOpen(false);
  }, [stop]);

  const removeChat = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const list = deleteConversation(id);
    setConversations(list);
    if (id === convIdRef.current) { convIdRef.current = newId(); setMessages([]); }
  }, []);

  const clearAllHistory = useCallback(() => {
    setConversations(clearConversations());
    convIdRef.current = newId();
    setMessages([]);
    setHistoryOpen(false);
  }, []);

  return (
    <div className="ai-chat">
      <div className="ai-chat__header">
        <span className="ai-chat__title"><Sparkles size={13} /> AI Chat</span>
        <div className="ai-chat__header-actions">
          <Tooltip content="New chat">
            <button className="ai-chat__icon-btn" aria-label="New chat" onClick={startNewChat}>
              <Plus size={15} />
            </button>
          </Tooltip>
          <Tooltip content="History">
            <button
              className={`ai-chat__icon-btn${historyOpen ? " is-active" : ""}`}
              aria-label="History"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <History size={14} />
            </button>
          </Tooltip>
          <Tooltip content="Close">
            <button className="ai-chat__icon-btn" aria-label="Close" onClick={onClose}><X size={15} /></button>
          </Tooltip>
        </div>
      </div>

      {historyOpen && (
        <div className="ai-chat__history-backdrop" onMouseDown={() => setHistoryOpen(false)}>
          <div className="ai-chat__history" onMouseDown={(e) => e.stopPropagation()}>
            <div className="ai-chat__history-head">
              <span>Recent chats</span>
              {conversations.length > 0 && (
                <button className="ai-chat__history-clear" onClick={clearAllHistory}>Clear all</button>
              )}
            </div>
            {conversations.length === 0 ? (
              <div className="ai-chat__history-empty">No saved chats yet</div>
            ) : (
              <ul className="ai-chat__history-list">
                {conversations.map((c) => (
                  <li
                    key={c.id}
                    className={`ai-chat__history-item${c.id === convIdRef.current ? " is-current" : ""}`}
                    onClick={() => loadChat(c)}
                  >
                    <span className="ai-chat__history-title">{c.title}</span>
                    <span className="ai-chat__history-time">{relativeTime(c.updatedAt, nowRef.current)}</span>
                    <Tooltip content="Delete">
                      <button className="ai-chat__history-del" aria-label="Delete chat" onClick={(e) => removeChat(c.id, e)}>
                        <Trash2 size={12} />
                      </button>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="ai-chat__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="ai-chat__empty">
            <Sparkles size={22} strokeWidth={1.5} />
            <p>Ask anything</p>
            <span>{useNoteContext ? "The active note is shared as context." : "Note context is off — ask freely."}</span>
          </div>
        )}
        {messages.map((m, i) => {
          const isStreaming = m.role === "assistant" && !m.content;
          const isError = m.content.startsWith("⚠️");
          const showActions = !isStreaming && !isError;
          return (
            <div key={i} className={`ai-chat__msg ai-chat__msg--${m.role}`}>
              <div className="ai-chat__bubble">
                {isStreaming ? (
                  <span className="ai-chat__typing"><span></span><span></span><span></span></span>
                ) : (
                  <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={mdComponents}>{m.content}</ReactMarkdown>
                )}
              </div>
              {showActions && (
                <div className="ai-chat__actions">
                  <Tooltip content={copiedIdx === i ? "Copied" : "Copy"}>
                    <button className="ai-chat__action" aria-label="Copy" onClick={() => copyMsg(m.content, i)}>
                      {copiedIdx === i ? <Check size={13} /> : <Copy size={13} />}
                    </button>
                  </Tooltip>
                  {m.role === "assistant" && (
                    <>
                      <Tooltip content="Insert into note">
                        <button className="ai-chat__action" aria-label="Insert into note" onClick={() => insertToNote(m.content)}>
                          <CornerDownLeft size={13} />
                        </button>
                      </Tooltip>
                      <Tooltip content="Regenerate">
                        <button className="ai-chat__action" aria-label="Regenerate" onClick={() => regenerate(i)} disabled={busy}>
                          <RotateCcw size={13} />
                        </button>
                      </Tooltip>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="ai-chat__composer">
        <div className="ai-chat__context-row">
          <Tooltip content={useNoteContext ? "Sharing the active note as context — click to turn off" : "Note context is off — click to share the active note"}>
            <button
              type="button"
              className={`ai-chat__context-pill${useNoteContext ? " is-on" : ""}`}
              onClick={toggleNoteContext}
            >
              <FileText size={12} />
              <span className="ai-chat__context-label">
                {useNoteContext
                  ? (activeNoteTitle ? `Using: ${activeNoteTitle}` : "Using active note")
                  : "Note context off"}
              </span>
            </button>
          </Tooltip>
          {liveRelevance && (
            <Tooltip content={
              liveRelevance === "low"
                ? "Your message looks unrelated to the open note — it will be ignored"
                : liveRelevance === "medium"
                  ? "The open note may be only loosely related to your message"
                  : "The open note is relevant to your message"
            }>
              <span className={`ai-chat__relevance is-${liveRelevance}`}>{relevanceLabel(liveRelevance)}</span>
            </Tooltip>
          )}
        </div>

        <div className="ai-chat__inputwrap">
          <textarea
            ref={inputRef}
            className="ai-chat__input"
            placeholder="Ask anything…  (Enter to send, Shift+Enter for newline)"
            value={input}
            rows={1}
            spellCheck={false}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <Tooltip content="Stop generating">
              <button className="ai-chat__send is-stop" aria-label="Stop" onClick={stop}><Square size={14} /></button>
            </Tooltip>
          ) : (
            <Tooltip content="Send" shortcut="Enter">
              <button className="ai-chat__send" aria-label="Send" onClick={send} disabled={!input.trim()}><Send size={14} /></button>
            </Tooltip>
          )}
        </div>
      </div>
    </div>
  );
});
