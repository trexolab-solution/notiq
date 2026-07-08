import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import {
  X, Send, Square, Trash2, CornerDownLeft, Sparkles, Copy, Check, RotateCcw, FileText, History,
  Plus, FilePlus2, ChevronDown, CheckSquare, Info, AlertTriangle, ArrowDown, FileCode, NotebookText,
} from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useShallow } from "zustand/shallow";
import { useAppStore } from "../../store";
import {
  aiCompleteStream, aiListModels, type ChatMessage, type StreamHandle, type ModelInfo,
} from "../../lib/ai/client";
import { chatSystem, type ChatContextFile } from "../../lib/ai/prompts";
import { mapAiError } from "../../lib/ai/errors";
import { getActiveEditor } from "../../lib/activeEditor";
import { insertAtCursor } from "../../lib/ai/actions";
import { resolveCodeLang } from "../../lib/ai/codeLang";
import { getLanguageFromPath, isMarkdownLike } from "../../lib/language";
import { getFileName } from "../../lib/pathUtils";
import { computePopoverPos } from "../../lib/popoverPosition";
import { toast } from "../../lib/toast";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Tooltip } from "../ui/Tooltip";
import { ModelPicker } from "./ModelPicker";
import {
  loadConversations, saveConversation, deleteConversation, clearConversations,
  relativeTime, type ChatConversation,
} from "../../lib/ai/chatHistory";
import type { AIProvider, Tab } from "../../types";

interface Msg {
  role: "user" | "assistant";
  content: string;
  /** A short system note about this reply (fallback switch, length cutoff) —
   *  rendered as a separate banner, never mixed into `content` so Copy/Insert
   *  only ever carry what the model actually said. */
  note?: string;
  noteTone?: "info" | "warning";
}

const MAX_NOTE_CHARS = 8000;
/** Combined ceiling across every selected context file, split proportionally. */
const MAX_TOTAL_CONTEXT_CHARS = 20000;
const PROVIDER_TAG: Record<AIProvider, string> = { cloud: "Cloud", local: "Local", openrouter: "OpenRouter" };
const DEFAULT_MODEL_VALUE = "__default__";

/** Display label for a tab in the context picker / pill — filename for real
 *  files, title for in-memory notes. */
function tabLabel(tab: Tab): string {
  return tab.filePath ? getFileName(tab.filePath) : tab.title;
}

/** A real (non-prose) file vs. a markdown note — same distinction the context
 *  block itself uses to decide whether to send fileName/language. */
function isCodeTab(tab: Tab): boolean {
  return !!tab.filePath && !(isMarkdownLike(tab.filePath) && !tab.language);
}

/** Default context selection: just the currently active note tab (matches the
 *  pre-multi-file behavior). Used for the initial state and every reset. */
function seedContextTabIds(): Set<string> {
  const st = useAppStore.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  return tab && tab.kind === "note" ? new Set([tab.id]) : new Set();
}

/** Build one chat-context entry from an open tab, capping its content at `cap`
 *  chars and only surfacing fileName/language for real (non-prose) files —
 *  mirrors the single-file logic this replaced. */
function tabToContextFile(tab: Tab, cap: number): ChatContextFile {
  const language = tab.language ?? getLanguageFromPath(tab.filePath);
  const isProseNote = !tab.filePath || (isMarkdownLike(tab.filePath) && !tab.language);
  return {
    title: tab.title !== "Untitled" ? tab.title : undefined,
    content: tab.content.slice(0, cap),
    fileName: !isProseNote ? tabLabel(tab) : undefined,
    language: !isProseNote ? language : undefined,
  };
}

/** Checklist popover anchored off the context pill's chevron — lets the user
 *  pick which open note/file tabs are included as chat context (Cursor-style). */
function ContextFilesPopover({ tabs, selected, onToggle, onSelectAll, onClearAll, onClose, anchorRef }: {
  tabs: Tab[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<ReturnType<typeof computePopoverPos> | null>(null);

  useEffect(() => {
    if (anchorRef.current) setPos(computePopoverPos(anchorRef.current, { minWidth: 260, maxHeight: 300 }));
  }, [anchorRef]);

  useClickOutside([anchorRef, popRef], onClose, true);
  useEscapeKey(onClose, true);

  if (!pos) return null;

  const allSelected = tabs.length > 0 && tabs.every((t) => selected.has(t.id));

  return createPortal(
    <div
      ref={popRef}
      className="ai-chat__ctx-popover"
      style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width }}
    >
      {tabs.length === 0 ? (
        <div className="ai-chat__ctx-popover-empty">
          <FileText size={18} />
          <span>No open notes/files</span>
        </div>
      ) : (
        <>
          <div className="ai-chat__ctx-popover-head">
            <span className="ai-chat__ctx-popover-count">{selected.size} of {tabs.length} selected</span>
            <button type="button" className="ai-chat__ctx-popover-selectall" onClick={allSelected ? onClearAll : onSelectAll}>
              {allSelected ? "Clear" : "Select all"}
            </button>
          </div>
          <ul className="ai-chat__ctx-popover-list">
            {tabs.map((t) => {
              const isSel = selected.has(t.id);
              const isCode = isCodeTab(t);
              return (
                <li
                  key={t.id}
                  className={`ai-chat__ctx-popover-row${isSel ? " is-selected" : ""}`}
                  onClick={() => onToggle(t.id)}
                >
                  {isSel ? <CheckSquare size={13} className="ai-chat__ctx-popover-check" /> : <Square size={13} className="ai-chat__ctx-popover-check" />}
                  {isCode
                    ? <FileCode size={13} className="ai-chat__ctx-popover-icon is-code" />
                    : <NotebookText size={13} className="ai-chat__ctx-popover-icon" />}
                  <span className="ai-chat__ctx-popover-label">{tabLabel(t)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>,
    document.body,
  );
}

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
  const aiEnabled  = useAppStore((s) => s.aiEnabled);
  const aiProvider = useAppStore((s) => s.aiProvider);
  const aiModel    = useAppStore((s) => s.aiModel);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [useNoteContext, setUseNoteContext] = useState(
    () => localStorage.getItem("pref:aiChatUseNoteContext") !== "false",
  );

  // Per-conversation model override — never touches the global Settings default.
  // Resets to "use the default" on New chat / loading a different conversation.
  const [modelOverride, setModelOverride] = useState<{ provider: AIProvider; model: string } | null>(null);
  const [modelChoices, setModelChoices] = useState<(ModelInfo & { provider: AIProvider })[] | null>(null);
  const modelsLoadingRef = useRef(false);

  // Lazily fetch every configured provider's model list on first dropdown open —
  // a provider with no key/unreachable local Ollama just drops out silently.
  const loadModelChoices = useCallback(() => {
    if (modelChoices !== null || modelsLoadingRef.current) return;
    modelsLoadingRef.current = true;
    Promise.allSettled(
      (["cloud", "local", "openrouter"] as AIProvider[]).map((p) =>
        aiListModels(p).then((list) => list.map((m) => ({ ...m, provider: p }))),
      ),
    ).then((results) => {
      const merged = results
        .filter((r): r is PromiseFulfilledResult<(ModelInfo & { provider: AIProvider })[]> => r.status === "fulfilled")
        .flatMap((r) => r.value)
        .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
      setModelChoices(merged);
      modelsLoadingRef.current = false;
    });
  }, [modelChoices]);

  // History
  const [conversations, setConversations] = useState<ChatConversation[]>(() => loadConversations());
  const [historyOpen, setHistoryOpen] = useState(false);
  const convIdRef = useRef<string>(newId());      // id of the conversation being edited
  const nowRef = useRef<number>(Date.now());

  // Open note/file tabs — the pool the context picker chooses from.
  const noteTabs = useAppStore(useShallow((s) => s.tabs.filter((t) => t.kind === "note")));

  // Which open tabs are included as chat context. Seeded to just the active
  // tab (matches the old single-file behavior); reset on New chat/load chat,
  // not persisted — a stale tab-id list from a past session is meaningless.
  const [contextTabIds, setContextTabIds] = useState<Set<string>>(seedContextTabIds);
  const [ctxPopoverOpen, setCtxPopoverOpen] = useState(false);
  const ctxPickerBtnRef = useRef<HTMLButtonElement>(null);

  const selectedTabs = useMemo(
    () => noteTabs.filter((t) => contextTabIds.has(t.id)),
    [noteTabs, contextTabIds],
  );

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

  const toggleContextTab = useCallback((id: string) => {
    setContextTabIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const selectAllContext = useCallback(() => {
    setContextTabIds(new Set(noteTabs.map((t) => t.id)));
  }, [noteTabs]);

  const clearAllContext = useCallback(() => setContextTabIds(new Set()), []);

  // Whether the view is "pinned" to the latest message — mirrors ChatGPT/Claude:
  // stream new tokens only autoscroll while the user hasn't scrolled away to
  // read something earlier. A ref (not just state) so the streaming callback
  // above always reads the current value without needing to be a dependency.
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    else el.scrollTop = el.scrollHeight;
  }, []);

  // Track how close to the bottom the user has scrolled; only "pinned" when
  // within a small threshold, so autoscroll disengages the moment they read up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setPinned(distanceFromBottom < 80);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Auto-scroll to bottom as messages grow — but only while pinned, so
  // scrolling up mid-stream to re-read something isn't yanked back down.
  useEffect(() => {
    if (pinnedRef.current) scrollToBottom();
  }, [messages, scrollToBottom]);

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
    const provider = modelOverride?.provider ?? aiProvider;
    const model = modelOverride?.model ?? aiModel;
    if (!model)     { toast.warning("Pick a model in Settings → AI"); return; }

    // Grab the checked context tabs for grounding (only when the toggle is on).
    // Total content is capped across all of them, split proportionally so N
    // files never blows the prompt past MAX_TOTAL_CONTEXT_CHARS.
    const st = useAppStore.getState();
    const activeTabs = useNoteContext
      ? st.tabs.filter((t) => t.kind === "note" && contextTabIds.has(t.id))
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

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setPinned(true);
    runCompletion([...messages, { role: "user", content: text }]);
  }, [input, busy, messages, runCompletion]);

  // Re-run the conversation up to (and including) the user turn that produced the
  // assistant message at `assistantIdx`, replacing that assistant reply.
  const regenerate = useCallback((assistantIdx: number) => {
    if (busy) return;
    const history = messages.slice(0, assistantIdx); // everything before this reply
    if (history.length === 0) return;
    setPinned(true);
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
    setModelOverride(null);
    setContextTabIds(seedContextTabIds());
    setPinned(true);
    setHistoryOpen(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [stop]);

  const loadChat = useCallback((c: ChatConversation) => {
    stop();
    convIdRef.current = c.id;
    setMessages(c.messages);
    setModelOverride(null);
    setContextTabIds(seedContextTabIds());
    setPinned(true);
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

  // A leading sentinel option reverts a per-conversation override to the global default.
  const modelExtraOptions = useMemo(() => [{
    value: DEFAULT_MODEL_VALUE,
    label: aiModel ? `Use default (${PROVIDER_TAG[aiProvider]} · ${aiModel})` : "Use default",
  }], [aiProvider, aiModel]);

  const modelSelectValue = modelOverride ? `${modelOverride.provider}::${modelOverride.model}` : DEFAULT_MODEL_VALUE;

  const onModelSelectChange = useCallback((v: string) => {
    if (v === DEFAULT_MODEL_VALUE) { setModelOverride(null); return; }
    const sep = v.indexOf("::");
    setModelOverride({ provider: v.slice(0, sep) as AIProvider, model: v.slice(sep + 2) });
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
            <span>{useNoteContext ? "Open notes/files can be shared as context." : "Note context is off — ask freely."}</span>
          </div>
        )}
        {messages.map((m, i) => {
          const isStreaming = m.role === "assistant" && !m.content;
          const isError = m.content.startsWith("⚠️");
          const showActions = !isStreaming && !isError;
          return (
            <div key={i} className={`ai-chat__msg ai-chat__msg--${m.role}`}>
              {m.note && (
                <div className={`ai-chat__note ai-chat__note--${m.noteTone ?? "info"}`}>
                  {m.noteTone === "warning" ? <AlertTriangle size={11} /> : <Info size={11} />}
                  <span>{m.note}</span>
                </div>
              )}
              <div className={`ai-chat__bubble${isError ? " is-error" : ""}`}>
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

      {!pinned && messages.length > 0 && (
        <Tooltip content="Jump to latest">
          <button
            type="button"
            className="ai-chat__jump-btn"
            aria-label="Jump to latest message"
            onClick={() => { scrollToBottom(true); setPinned(true); }}
          >
            <ArrowDown size={13} />
          </button>
        </Tooltip>
      )}

      <div className="ai-chat__composer">
        <div className="ai-chat__context-row">
          <Tooltip content={useNoteContext ? "Sharing selected files as context — click to turn off" : "Note context is off — click to turn on"}>
            <button
              type="button"
              className={`ai-chat__context-pill${useNoteContext ? " is-on" : ""}`}
              onClick={toggleNoteContext}
            >
              <FileText size={12} />
              <span className="ai-chat__context-label">
                {!useNoteContext
                  ? "Note context off"
                  : selectedTabs.length === 0
                    ? "No files selected"
                    : selectedTabs.length === 1
                      ? `Using: ${tabLabel(selectedTabs[0])}`
                      : `Using: ${selectedTabs.length} files`}
              </span>
            </button>
          </Tooltip>
          {useNoteContext && (
            <Tooltip content="Choose which open files to include">
              <button
                type="button"
                ref={ctxPickerBtnRef}
                className={`ai-chat__ctx-picker-btn${ctxPopoverOpen ? " is-active" : ""}`}
                aria-label="Choose context files"
                onClick={(e) => { e.stopPropagation(); setCtxPopoverOpen((v) => !v); }}
              >
                <ChevronDown size={11} />
              </button>
            </Tooltip>
          )}
          {ctxPopoverOpen && (
            <ContextFilesPopover
              tabs={noteTabs}
              selected={contextTabIds}
              onToggle={toggleContextTab}
              onSelectAll={selectAllContext}
              onClearAll={clearAllContext}
              onClose={() => setCtxPopoverOpen(false)}
              anchorRef={ctxPickerBtnRef}
            />
          )}

          <ModelPicker
            variant="pill"
            unified
            value={modelSelectValue}
            onChange={onModelSelectChange}
            onOpen={loadModelChoices}
            models={modelChoices ?? []}
            extraOptions={modelExtraOptions}
            aria-label="Model for this chat"
          />
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
