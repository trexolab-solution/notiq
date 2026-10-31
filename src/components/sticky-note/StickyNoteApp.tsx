import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import Editor, { type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { applyTheme } from "../../lib/themes";
import { STATIC_EDITOR_OPTIONS } from "../../lib/monacoOptions"
import { useStickyNotesStore } from "../../store/stickyNoteStore";
import { registerEditor, unregisterEditor } from "../../lib/activeEditor";
import { ensureInlineProvider } from "../../lib/ai/inlineCompletions";
import { attachAiLoader } from "../../lib/ai/inlineLoader";
import { aiActivity } from "../../lib/ai/activity";
import { StickyNoteHeader } from "./StickyNoteHeader";
import { ContextMenu } from "../ui/ContextMenu";
import { buildEditItems } from "../../lib/contextMenu/items";
import { monacoEditActions, monacoEditState } from "../../lib/contextMenu/monacoActions";
import { useWindowContextMenu } from "../../hooks/useWindowContextMenu";

const DARK_THEMES = new Set([
  "dark", "one-dark", "nord", "dracula", "catppuccin", "tokyo-night", "rose-pine",
]);

/** Returns true if a hex color is perceptually light. */
function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const toLinear = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b) > 0.4;
}

function getNoteIdFromHash(): string {
  // hash: #/sticky-note/{id}
  const parts = window.location.hash.split("/");
  return parts[2] ?? "";
}

export default function StickyNoteApp() {
  const noteId = useMemo(getNoteIdFromHash, []);
  const note = useStickyNotesStore((s) => s.notes[noteId]);
  const updateNote = useStickyNotesStore((s) => s.updateNote);

  // Fallback defaults if note not yet in store
  const content = note?.content ?? "";
  const language = note?.language ?? "markdown";
  const bgColor = note?.bgColor ?? "";
  const fontSize = note?.fontSize ?? 14;
  const unfocusedOpacity = note?.unfocusedOpacity ?? 0.5;

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const [themeId, setThemeId] = useState(
    () => localStorage.getItem("pref:theme") || "dark",
  );
  const [focused, setFocused] = useState(true);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // Mark the document as a sticky-note window + apply initial theme
  useEffect(() => {
    document.documentElement.classList.add("is-sticky-note");
    applyTheme(themeId as Parameters<typeof applyTheme>[0]);
  }, []);

  // Ensure note exists in store
  useEffect(() => {
    if (!note && noteId) {
      updateNote(noteId, { content: "" });
    }
  }, [noteId, note, updateNote]);

  // Live theme sync from main window
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ themeId: string }>("theme-changed", (e) => {
      const id = e.payload.themeId;
      applyTheme(id as Parameters<typeof applyTheme>[0]);
      setThemeId(id);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Focus / blur transparency — use Tauri's native window focus event
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload: isFocused }) => setFocused(isFocused))
      .then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Show window after first render
  useEffect(() => {
    const win = getCurrentWindow();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        win.show().catch((e) => console.warn("sticky-note: show failed", e));
        // Re-enable shadow at runtime — must be off initially for transparency
        // to work on Windows, but we can turn it on after the first paint.
        win.setShadow(true).catch((e) => console.warn("sticky-note: setShadow failed", e));
      }),
    );

    // Cleanup open-window tracking when destroyed (Alt+F4 / native close)
    let unlisten: (() => void) | undefined;
    win.onCloseRequested((event) => {
      event.preventDefault();
      useStickyNotesStore.getState().removeOpenWindow(noteId);
      win.destroy();
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [noteId]);

  // Window drag
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    if (e.buttons !== 1) return;
    const el = e.target as HTMLElement;
    if (el.closest("button, input, select")) return;
    getCurrentWindow().startDragging();
  }, []);

  // Font size shortcuts: Ctrl+= / Ctrl+-
  // Use refs so the listener doesn't re-register on every font size change.
  const fontSizeRef = useRef(fontSize);
  fontSizeRef.current = fontSize;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        updateNote(noteId, { fontSize: Math.min(32, fontSizeRef.current + 1) });
      } else if (e.key === "-") {
        e.preventDefault();
        updateNote(noteId, { fontSize: Math.max(8, fontSizeRef.current - 1) });
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [noteId, updateNote]);

  // Disposer for the AI shimmer loader widget (cleaned up on unmount).
  const detachAiLoaderRef = useRef<(() => void) | null>(null);

  // Mount editor: disable F1/command palette, register for context menu, AI autocomplete
  const handleEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    registerEditor(editor);

    // ── AI: inline autocomplete (ghost text) + manual trigger + busy shimmer ──
    // The provider reads live AI settings and is a no-op when AI/autocomplete is
    // off, so this is safe to attach unconditionally.
    ensureInlineProvider(monaco);
    editor.addAction({
      id: "sticky.ai.trigger",
      label: "AI: Trigger Autocomplete",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Backslash],
      run: (ed) => { ed.trigger("ai", "editor.action.inlineSuggest.trigger", {}); },
    });
    detachAiLoaderRef.current = attachAiLoader(editor, monaco);

    // Esc cancels in-flight AI work (only when something is running).
    editor.onKeyDown((e) => {
      if (e.keyCode === monaco.KeyCode.Escape && aiActivity.isActive() && aiActivity.cancelAll()) {
        e.preventDefault();
        e.stopPropagation();
      }
    });

    // Disable F1 command palette
    editor.addCommand(monaco.KeyCode.F1, () => { });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => { });

    // Keep Monaco's built-in context menu disabled
    editor.updateOptions({ contextmenu: false });

    // Show our custom context menu on right-click
    const dom = editor.getDomNode();
    if (dom) {
      dom.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setCtxMenu({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY });
      }, true);
    }
  }, []);

  // Cleanup editor registration on unmount
  useEffect(() => {
    return () => {
      detachAiLoaderRef.current?.();
      detachAiLoaderRef.current = null;
      if (editorRef.current) {
        unregisterEditor(editorRef.current);
        editorRef.current = null;
      }
    };
  }, []);

  // ── Context menu: the shared edit items for this note's editor ───────
  const ctxMenuItems = ctxMenu && editorRef.current
    ? buildEditItems(monacoEditState(editorRef.current), monacoEditActions(editorRef.current))
    : [];

  const isDark = DARK_THEMES.has(themeId);
  // When a custom bg color is set, pick Monaco theme by its brightness;
  // otherwise follow the app theme.
  const monacoTheme = bgColor
    ? (isLightColor(bgColor) ? "vs" : "vs-dark")
    : (isDark ? "vs-dark" : "vs");

  const shellStyle: React.CSSProperties = {
    opacity: focused ? 1 : unfocusedOpacity,
    transition: "opacity 150ms ease",
    ...(bgColor ? { background: bgColor } : {}),
  };

  const windowMenu = useWindowContextMenu();

  return (
    <div className="sticky-note-shell" style={shellStyle}>
      <div onMouseDown={handleHeaderMouseDown}>
        <StickyNoteHeader noteId={noteId} />
      </div>

      <div className="sticky-note-editor">
        <Editor
          language={language}
          value={content}
          onChange={(v) => updateNote(noteId, { content: v ?? "" })}
          onMount={handleEditorMount}
          theme={monacoTheme}
          options={{
            ...STATIC_EDITOR_OPTIONS,
            fontSize,
            lineHeight: Math.round(fontSize * 1.7),
            wordWrap: "on",
            lineNumbers: "off",
            lineDecorationsWidth: 10,
            lineNumbersMinChars: 0,
            minimap: { enabled: false },
            folding: false,
            renderLineHighlight: "none",
            scrollBeyondLastLine: false,
            padding: { top: 4, bottom: 8 },
            scrollbar: { verticalScrollbarSize: 6, horizontalScrollbarSize: 6, useShadows: false },
            contextmenu: false
          }}
        />
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenuItems}
          onClose={() => { setCtxMenu(null); editorRef.current?.focus(); }}
        />
      )}
      {windowMenu}
    </div>
  );
}
