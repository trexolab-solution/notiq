import type * as monacoNs from "monaco-editor";
import { aiActivity } from "./activity";

type Editor = monacoNs.editor.ICodeEditor;

/**
 * Cursor/Copilot-style shimmer placeholder shown inline, exactly at the caret,
 * while the AI is busy. Implemented as an injected-text decoration (not a content
 * widget) so it sits precisely in the text layout — no pixel math, no vertical
 * offset from surrounding chrome (toolbar/titlebar).
 */
export function attachAiLoader(editor: Editor, monaco: typeof monacoNs): () => void {
  // A run of non-breaking spaces gives the injected span its width; the shimmer
  // gradient is painted over it via the inline class (the text itself is hidden).
  const SHIMMER_CONTENT = "        ";

  // Keep the shimmer up for at least this long once shown, so very fast
  // autocomplete responses still produce a perceptible flash rather than nothing.
  const MIN_VISIBLE_MS = 280;

  const decorations = editor.createDecorationsCollection();
  let visible = false;
  let shownAt = 0;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function decorationAtCaret(): monacoNs.editor.IModelDeltaDecoration[] {
    const pos = editor.getPosition();
    if (!pos) return [];
    return [
      {
        range: new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
        options: {
          showIfCollapsed: true,
          after: {
            content: SHIMMER_CONTENT,
            inlineClassName: "ai-shimmer-inline",
          },
        },
      },
    ];
  }

  function render() {
    decorations.set(visible ? decorationAtCaret() : []);
  }

  function setVisible(busy: boolean) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (busy) {
      visible = true;
      shownAt = Date.now();
      render();
    } else {
      // Enforce a minimum on-screen time so a sub-frame request still flashes.
      const elapsed = Date.now() - shownAt;
      const wait = Math.max(0, MIN_VISIBLE_MS - elapsed);
      if (wait === 0) { visible = false; render(); }
      else hideTimer = setTimeout(() => { visible = false; hideTimer = null; render(); }, wait);
    }
  }

  const activitySub = aiActivity.subscribe(setVisible);

  // Follow the caret while the AI is working (e.g. streaming inserts move it).
  const cursorSub = editor.onDidChangeCursorSelection(() => {
    if (visible) render();
  });

  return () => {
    if (hideTimer) clearTimeout(hideTimer);
    activitySub();
    cursorSub.dispose();
    decorations.clear();
  };
}
