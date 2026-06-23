import React, { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import Editor, { type OnMount, type OnChange } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { useAppStore } from "../../store";
import { useMonacoEditorPreferences } from "../../store/selectors";
import { buildDynamicOptions, STATIC_EDITOR_OPTIONS } from "../../lib/monacoOptions";
import { useScrollSync } from "../../hooks/useScrollSync";
import { registerEditor, unregisterEditor } from "../../lib/activeEditor";
import { ensureInlineProvider } from "../../lib/ai/inlineCompletions";
import { attachSelectionToolbar } from "../../lib/ai/selectionToolbar";
import { attachAiLoader } from "../../lib/ai/inlineLoader";
import { aiContinue, aiSummarize, aiFixGrammar, aiGenerateTitle, aiFixMermaid } from "../../lib/ai/actions";
import { aiActivity } from "../../lib/ai/activity";
import { MarkdownToolbar, applyFormat, detectActiveFormats, type FormatAction } from "./MarkdownToolbar";
import { formatDocument } from "../../lib/formatter";
import { toast } from "../../lib/toast";
import { extractImagesFromClipboard, handlePastedImage } from "../../lib/pasteImage";

interface MonacoMarkdownEditorProps {
  tabId: string;
  content: string;
  themeId: string;
  /** Monaco language id — defaults to "markdown" for in-memory notes. */
  language?: string;
  onScrollChange?: (ratio: number) => void;
  /** When true the editor applies its own responsive horizontal padding so the
   *  parent wrapper can be full-width with no extra centering divs. */
  horizontalPadding?: boolean;
  /** Show toolbar for non-markdown files too (with Format button only) */
  showToolbar?: boolean;
}

export interface MonacoEditorHandle {
  scrollTo: (ratio: number) => void;
}

// Map app theme to Monaco's built-in themes
function getMonacoTheme(themeId: string): string {
  return themeId === "light" ? "vs" : "vs-dark";
}

const MIN_FONT = 8;
const MAX_FONT = 32;

// Per-tab Monaco view-state (scroll + cursor + folding) for the current session.
// Survives tab switches because the single editor instance is reused; an app
// restart falls back to the persisted scroll ratio on the tab.
const tabViewStates = new Map<string, monaco.editor.ICodeEditorViewState>();

// ── Component ─────────────────────────────────────────────────────────────────
export const MonacoMarkdownEditor = React.memo(
  React.forwardRef<MonacoEditorHandle, MonacoMarkdownEditorProps>(
    function MonacoMarkdownEditor({ tabId, content, themeId, language, onScrollChange, horizontalPadding: _horizontalPadding, showToolbar }, ref) {
      const lang         = language ?? "markdown";
      const isMdLang     = lang === "markdown" || lang === "plaintext";
      const updateTabContent   = useAppStore((s) => s.updateTabContent);
      const updateTabCursor    = useAppStore((s) => s.updateTabCursor);
      const updateTabScroll    = useAppStore((s) => s.updateTabScroll);
      const pendingJump        = useAppStore((s) => s.pendingJump);
      const clearPendingJump   = useAppStore((s) => s.clearPendingJump);

      const prefs = useMonacoEditorPreferences();
      const { editorFontSize, setEditorFontSize } = prefs;

      const editorRef    = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
      const containerRef = useRef<HTMLDivElement>(null);
      const [activeFormats, setActiveFormats] = useState<Set<FormatAction>>(new Set());
      const { isSyncingRef, reportScroll } = useScrollSync(onScrollChange);
      // Refs so the stable handleMount closure can call latest actions
      const updateTabScrollRef = useRef(updateTabScroll);
      updateTabScrollRef.current = updateTabScroll;
      const currentTabIdRef    = useRef(tabId);
      currentTabIdRef.current   = tabId;
      const scrollSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

      // ── Imperative handle: let parent drive scroll position ───────────────
      useImperativeHandle(ref, () => ({
        scrollTo(ratio: number) {
          const editor = editorRef.current;
          if (!editor) return;
          const info = editor.getLayoutInfo();
          const max  = editor.getScrollHeight() - info.height;
          if (max <= 0) return;
          isSyncingRef.current = true;
          editor.setScrollTop(ratio * max);
          setTimeout(() => { isSyncingRef.current = false; }, 50);
        },
      }));

      // Sync language to Monaco model when it changes (e.g. switching tabs)
      useEffect(() => {
        const ed = editorRef.current;
        if (!ed) return;
        const model = ed.getModel();
        if (model) monaco.editor.setModelLanguage(model as monaco.editor.ITextModel, lang);
      }, [lang]);

      const handleMount: OnMount = useCallback(
        (editor) => {
          editorRef.current = editor;
          registerEditor(editor);

          // ── AI: inline autocomplete provider (registered once) + actions ──
          ensureInlineProvider(monaco);
          editor.addAction({
            id: "smart-note.ai.trigger",
            label: "AI: Trigger Autocomplete",
            keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.Backslash],
            run: (ed) => { ed.trigger("ai", "editor.action.inlineSuggest.trigger", {}); },
          });
          editor.addAction({ id: "smart-note.ai.continue",      label: "AI: Continue Writing", run: () => { void aiContinue(editor); } });
          editor.addAction({ id: "smart-note.ai.summarize",     label: "AI: Summarize Note",   run: () => { void aiSummarize(editor); } });
          editor.addAction({ id: "smart-note.ai.fixGrammar",    label: "AI: Fix Grammar",      run: () => { void aiFixGrammar(editor); } });
          editor.addAction({ id: "smart-note.ai.generateTitle", label: "AI: Generate Title",   run: () => { void aiGenerateTitle(editor); } });
          editor.addAction({ id: "smart-note.ai.fixMermaid",    label: "AI: Fix Mermaid",      run: () => { void aiFixMermaid(editor); } });

          // Esc cancels any in-flight AI work (streaming or not), and only when
          // something is running, so it doesn't disturb Monaco's normal Esc.
          editor.onKeyDown((e) => {
            if (e.keyCode === monaco.KeyCode.Escape && aiActivity.isActive()) {
              if (aiActivity.cancelAll()) {
                e.preventDefault();
                e.stopPropagation();
                toast.info("AI stopped");
              }
            }
          });

          // Floating AI quick-actions toolbar on text selection.
          const detachSelToolbar = attachSelectionToolbar(editor, monaco);
          const detachAiLoader = attachAiLoader(editor, monaco);
          editor.onDidDispose(() => {
            detachSelToolbar();
            detachAiLoader();
          });

          // ── F1: disable Monaco's own palette ─────────────────────────────
          editor.addAction({
            id: "noop-command-palette",
            label: "Command Palette (disabled)",
            keybindings: [monaco.KeyCode.F1],
            run: () => { /* intentionally disabled */ },
          });
          // ── Ctrl+Shift+P → open the app's command palette ────────────────
          editor.addAction({
            id: "smart-note.command-palette",
            label: "Command Palette",
            keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP],
            run: () => { window.dispatchEvent(new CustomEvent("app:command-palette")); },
          });

          // ── Format document: Shift+Alt+F (all languages) ─────────────────
          editor.addAction({
            id: "smart-note.format",
            label: "Format Document",
            keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
            run: async (ed) => {
              try {
                const result = await formatDocument(ed as monaco.editor.IStandaloneCodeEditor);
                if (result.ok) toast.success("Document formatted");
                else           toast.error(`Format failed: ${result.message}`);
              } catch (err) {
                toast.error(`Format failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            },
          });

          // ── Markdown formatting shortcuts (md/txt only) ──────────────────
          if (isMdLang) {
          const shortcuts: Array<[string, string, number, FormatAction]> = [
            ["md-bold",          "Bold",           monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB,                               "bold"],
            ["md-italic",        "Italic",         monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI,                               "italic"],
            ["md-strikethrough", "Strikethrough",  monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyX,         "strikethrough"],
            ["md-code",          "Inline Code",    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyE,                               "code"],
            ["md-link",          "Link",           monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK,                               "link"],
            ["md-h1",            "Heading 1",      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt  | monaco.KeyCode.Digit1,        "h1"],
            ["md-h2",            "Heading 2",      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt  | monaco.KeyCode.Digit2,        "h2"],
            ["md-h3",            "Heading 3",      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt  | monaco.KeyCode.Digit3,        "h3"],
            ["md-ul",            "Bullet List",    monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit8,       "ul"],
            ["md-ol",            "Ordered List",   monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit7,       "ol"],
            ["md-task",          "Task List",      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Digit9,       "task"],
            ["md-blockquote",    "Blockquote",     monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Period,       "blockquote"],
            ["md-codeblock",     "Code Block",     monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt  | monaco.KeyCode.KeyC,          "codeblock"],
            ["md-hr",            "Horizontal Rule",monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyH,         "hr"],
            ["md-table",         "Table",          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyT,         "table"],
          ];
          for (const [id, label, kb, action] of shortcuts) {
            editor.addAction({ id, label, keybindings: [kb], run: (ed) => applyFormat(ed as monaco.editor.IStandaloneCodeEditor, action) });
          }
          }

          // ── Scroll sync + persist ──────────────────────────────────────────
          editor.onDidScrollChange((e) => {
            // Snapshot full view-state for instant same-session tab restore.
            const vs = editor.saveViewState();
            if (vs) tabViewStates.set(currentTabIdRef.current, vs);

            if (isSyncingRef.current) return;
            const viewHeight = editor.getLayoutInfo().height;
            const max = e.scrollHeight - viewHeight;
            if (max <= 0) return;
            const ratio = e.scrollTop / max;
            reportScroll(ratio);
            // Debounce-persist scroll ratio so graph navigation + app restart can restore it
            if (scrollSaveTimerRef.current) clearTimeout(scrollSaveTimerRef.current);
            scrollSaveTimerRef.current = setTimeout(() => {
              updateTabScrollRef.current(currentTabIdRef.current, ratio);
            }, 400);
          });

          // ── Cursor tracking ──────────────────────────────────────────────
          editor.onDidChangeCursorSelection((e) => {
            const { positionLineNumber: ln, positionColumn: col } = e.selection;
            updateTabCursor(tabId, ln, col);

            // Keep the session view-state fresh so cursor + scroll restore on tab switch.
            const vs = editor.saveViewState();
            if (vs) tabViewStates.set(currentTabIdRef.current, vs);

            const mdl = editor.getModel();
            if (!mdl) return;
            const pos = { lineNumber: ln, column: col } as monaco.Position;
            const next = detectActiveFormats(mdl, pos);
            // Skip re-render when the active set is identical
            setActiveFormats((prev) => {
              const prevKey = [...prev].sort().join(",");
              const nextKey = [...next].sort().join(",");
              return prevKey === nextKey ? prev : next;
            });
          });

          // All standard VS Code shortcuts (Alt+↑/↓ move line, Shift+Alt+↑/↓
          // copy line, Ctrl+Shift+K delete line, Ctrl+/ comment, Ctrl+D next
          // occurrence, Ctrl+L select line, Ctrl+Shift+L select all matches,
          // Ctrl+]/[ indent/outdent, Ctrl+F find, Ctrl+H replace, multi-cursor,
          // etc.) are part of Monaco's built-in keybinding system and work
          // without any manual addCommand wiring.

          // ── Markdown: list continuation + Tab indent (md/txt only) ──────
          if (isMdLang) {
          editor.onKeyDown((e) => {
            if (
              e.keyCode !== monaco.KeyCode.Enter ||
              e.shiftKey || e.ctrlKey || e.altKey || e.metaKey
            ) return;

            const model = editor.getModel();
            const pos   = editor.getPosition();
            if (!model || !pos) return;

            const lineContent = model.getLineContent(pos.lineNumber);
            const listMatch   = lineContent.match(/^(\s*)([-*+]|\d+\.)\s(.*)$/);
            if (!listMatch) return;

            const [, indent, marker, content] = listMatch;
            e.preventDefault();
            e.stopPropagation();

            if (content.trim() === "") {
              const newIndent = indent.length >= 2 ? indent.slice(0, -2) : "";
              editor.executeEdits("md-list-exit", [{
                range: new monaco.Range(pos.lineNumber, 1, pos.lineNumber, lineContent.length + 1),
                text: newIndent + "\n",
              }]);
            } else {
              const nextMarker = /^\d+\.$/.test(marker)
                ? String(parseInt(marker) + 1) + "."
                : marker;
              editor.trigger("keyboard", "type", { text: "\n" + indent + nextMarker + " " });
            }
          });

          editor.onKeyDown((e) => {
            if (e.keyCode !== monaco.KeyCode.Tab) return;
            const model = editor.getModel();
            const pos   = editor.getPosition();
            if (!model || !pos) return;
            if (!model.getLineContent(pos.lineNumber).match(/^\s*[-*+\d]/)) return;

            e.preventDefault();
            e.stopPropagation();
            editor.trigger("kb", e.shiftKey
              ? "editor.action.outdentLines"
              : "editor.action.indentLines", null);
          });

          }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [tabId, updateTabCursor, isMdLang, reportScroll]
      );

      const handleChange: OnChange = useCallback(
        (value) => updateTabContent(tabId, value ?? ""),
        [tabId, updateTabContent]
      );

      // ── Ctrl+scroll / Ctrl+Plus / Ctrl+Minus → font size ──────────────────
      useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const adjustSize = (delta: number) => {
          const cur = editorRef.current?.getOption(monaco.editor.EditorOption.fontSize) ?? editorFontSize;
          const next = Math.min(MAX_FONT, Math.max(MIN_FONT, cur + delta));
          if (next === cur) return;
          editorRef.current?.updateOptions({ fontSize: next });
          setEditorFontSize(next);
        };

        const onWheel = (e: WheelEvent) => {
          if (!e.ctrlKey) return;
          e.preventDefault();
          adjustSize(e.deltaY < 0 ? 1 : -1);
        };

        const onKeyDown = (e: KeyboardEvent) => {
          if (!e.ctrlKey || e.altKey || e.shiftKey) return;
          // Equal/Plus key → zoom in, Minus key → zoom out, Digit0 → reset
          if (e.key === "=" || e.key === "+") {
            e.preventDefault();
            adjustSize(1);
          } else if (e.key === "-") {
            e.preventDefault();
            adjustSize(-1);
          } else if (e.key === "0") {
            e.preventDefault();
            const def = 15;
            editorRef.current?.updateOptions({ fontSize: def });
            setEditorFontSize(def);
          }
        };

        el.addEventListener("wheel", onWheel, { passive: false });
        el.addEventListener("keydown", onKeyDown);
        return () => {
          el.removeEventListener("wheel", onWheel);
          el.removeEventListener("keydown", onKeyDown);
        };
      }, [setEditorFontSize, editorFontSize]);

      // Unregister editor from the active-editor registry on unmount
      useEffect(() => {
        return () => {
          if (editorRef.current) unregisterEditor(editorRef.current);
        };
      }, []);

      // ── Clipboard image paste → write to temp/note-dir + insert markdown ──
      // Listens on the wrapper div so it catches paste events bubbling from Monaco's
      // internal textarea. Capture phase = fires before Monaco's own paste handler,
      // letting us preventDefault when the clipboard holds an image.
      useEffect(() => {
        if (!isMdLang) return;
        const host = containerRef.current;
        if (!host) return;

        const onPaste = async (e: ClipboardEvent) => {
          const blobs = extractImagesFromClipboard(e);
          if (blobs.length === 0) return; // not an image — let Monaco handle text paste

          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();

          const editor = editorRef.current;
          if (!editor) return;

          try {
            for (const blob of blobs) {
              await handlePastedImage(editor, currentTabIdRef.current, blob);
            }
            toast.success("Image pasted");
          } catch (err) {
            console.error("paste-image failed", err);
            toast.error(`Couldn't paste image: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        host.addEventListener("paste", onPaste, { capture: true });
        return () => host.removeEventListener("paste", onPaste, { capture: true });
      }, [isMdLang]);

      // Sync all editor options from store or prop changes
      useEffect(() => {
        editorRef.current?.updateOptions(buildDynamicOptions(prefs));
      }, [prefs]);

      // Re-detect active formats when the tab switches (content has changed but
      // the cursor position event may not fire until the user moves the cursor)
      useEffect(() => {
        const ed  = editorRef.current;
        if (!ed) return;
        const mdl = ed.getModel();
        const pos = ed.getPosition();
        if (mdl && pos) setActiveFormats(detectActiveFormats(mdl, pos));
        else            setActiveFormats(new Set());
      }, [tabId]);

      // Restore scroll + cursor when this tab becomes active.
      //  • Same session: replay the saved Monaco view-state (exact scroll + cursor).
      //  • After app restart (no view-state yet): fall back to the persisted ratio.
      // Skip when a pending graph-jump will position the editor instead.
      useEffect(() => {
        if (useAppStore.getState().pendingJump?.tabId === tabId) return;

        const saved = tabViewStates.get(tabId);
        if (saved) {
          let raf = requestAnimationFrame(() => {
            const ed = editorRef.current;
            if (!ed) return;
            isSyncingRef.current = true;
            ed.restoreViewState(saved);
            setTimeout(() => { isSyncingRef.current = false; }, 50);
          });
          return () => cancelAnimationFrame(raf);
        }

        const tab = useAppStore.getState().tabs.find((t) => t.id === tabId);
        if (!tab || tab.scrollPosition === 0) return;
        const ratio = tab.scrollPosition;
        let raf: number;
        const tryRestore = () => {
          const ed = editorRef.current;
          if (!ed) return;
          const info = ed.getLayoutInfo();
          const max  = ed.getScrollHeight() - info.height;
          if (max <= 0) { raf = requestAnimationFrame(tryRestore); return; }
          isSyncingRef.current = true;
          ed.setScrollTop(ratio * max);
          setTimeout(() => { isSyncingRef.current = false; }, 50);
        };
        raf = requestAnimationFrame(tryRestore);
        return () => cancelAnimationFrame(raf);
      }, [tabId]);

      // Jump to the node name text when navigating here from the knowledge graph
      useEffect(() => {
        if (!pendingJump || pendingJump.tabId !== tabId) return;
        let raf: number;
        const tryJump = () => {
          const ed = editorRef.current;
          if (!ed) { raf = requestAnimationFrame(tryJump); return; }
          const model = ed.getModel();
          if (!model) { raf = requestAnimationFrame(tryJump); return; }
          const matches = model.findMatches(
            pendingJump.searchText,
            false, // searchOnlyEditableRange
            false, // isRegex
            false, // matchCase
            null,  // wordSeparators
            false  // captureMatches
          );
          if (matches.length > 0) {
            const range = matches[0].range;
            isSyncingRef.current = true;
            ed.revealLineInCenter(range.startLineNumber);
            ed.setSelection(range);
            setTimeout(() => { isSyncingRef.current = false; }, 50);
          }
          clearPendingJump();
        };
        raf = requestAnimationFrame(tryJump);
        return () => cancelAnimationFrame(raf);
      }, [pendingJump, tabId, clearPendingJump]);

      return (
        <div
          ref={containerRef}
          style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
        >
          {(isMdLang || showToolbar) && (
            <MarkdownToolbar
              editorRef={editorRef}
              activeFormats={activeFormats}
              showFormat={true}
              showMarkdownTools={isMdLang}
            />
          )}
          <Editor
            height="100%"
            // A unique path per tab makes @monaco-editor/react keep a separate
            // model per tab and natively save/restore its scroll + cursor on
            // switch (saveViewState defaults to true). Without it every tab
            // shares one model and the value swap resets scroll to the top.
            path={tabId}
            language={lang}
            value={content}
            theme={getMonacoTheme(themeId)}
            onChange={handleChange}
            onMount={handleMount}
            options={{
              ...STATIC_EDITOR_OPTIONS,
              ...buildDynamicOptions(prefs),
            }}
          />
        </div>
      );
    }
  )
);
