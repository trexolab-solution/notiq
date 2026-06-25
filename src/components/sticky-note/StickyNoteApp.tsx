import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import Editor, { type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Clipboard, Copy, Scissors, RotateCcw, RotateCw, SquareMousePointer } from "lucide-react";
import { applyTheme } from "../../lib/themes";
import { STATIC_EDITOR_OPTIONS } from "../../lib/monacoOptions"
import { useStickyNotesStore } from "../../store/stickyNoteStore";
import { registerEditor, unregisterEditor } from "../../lib/activeEditor";
import { ensureInlineProvider } from "../../lib/ai/inlineCompletions";
import { attachAiLoader } from "../../lib/ai/inlineLoader";
import { aiActivity } from "../../lib/ai/activity";
import { StickyNoteHeader } from "./StickyNoteHeader";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";

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

  // ── Context menu actions ─────────────────────────────────────────────
  const handleCut = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const selection = ed.getSelection();
    const model = ed.getModel();
    if (selection && model && !selection.isEmpty()) {
      await writeText(model.getValueInRange(selection));
      ed.executeEdits("ctx-cut", [{ range: selection, text: "", forceMoveMarkers: true }]);
    }
    ed.focus();
  }, []);

  const handleCopy = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const selection = ed.getSelection();
    const model = ed.getModel();
    if (selection && model && !selection.isEmpty()) {
      await writeText(model.getValueInRange(selection));
    }
    ed.focus();
  }, []);

  const handlePaste = useCallback(async () => {
    const ed = editorRef.current;
    if (!ed) return;
    const text = await readText().catch(() => "");
    ed.focus();
    if (text) ed.trigger("ctx-paste", "type", { text });
  }, []);

  const handleUndo = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.trigger("ctx-menu", "undo", null);
    ed.focus();
  }, []);

  const handleRedo = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.trigger("ctx-menu", "redo", null);
    ed.focus();
  }, []);

  const handleSelectAll = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const model = ed.getModel();
    if (model) ed.setSelection(model.getFullModelRange());
    ed.focus();
  }, []);

  const hasSelection = editorRef.current?.getSelection()
    ? !editorRef.current.getSelection()!.isEmpty()
    : false;

  const ctxMenuItems: ContextMenuItem[] = [
    { type: "item", label: "Cut",        icon: <Scissors size={13} />,           shortcut: "Ctrl+X", disabled: !hasSelection, onClick: handleCut },
    { type: "item", label: "Copy",       icon: <Copy size={13} />,               shortcut: "Ctrl+C", disabled: !hasSelection, onClick: handleCopy },
    { type: "item", label: "Paste",      icon: <Clipboard size={13} />,          shortcut: "Ctrl+V", onClick: handlePaste },
    { type: "separator" },
    { type: "item", label: "Undo",       icon: <RotateCcw size={13} />,          shortcut: "Ctrl+Z", onClick: handleUndo },
    { type: "item", label: "Redo",       icon: <RotateCw size={13} />,           shortcut: "Ctrl+Y", onClick: handleRedo },
    { type: "separator" },
    { type: "item", label: "Select All", icon: <SquareMousePointer size={13} />, shortcut: "Ctrl+A", onClick: handleSelectAll },
  ];

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
    </div>
  );
}
