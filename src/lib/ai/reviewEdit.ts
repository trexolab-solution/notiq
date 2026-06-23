import * as monaco from "monaco-editor";
import { attachTooltip } from "../domTooltip";

type Editor = monaco.editor.ICodeEditor;

const SVG = (inner: string) =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICON_ACCEPT = SVG('<path d="M20 6 9 17l-5-5"/>');
const ICON_REJECT = SVG('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');
const ICON_RETRY = SVG('<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>');

export interface ReviewActions {
  /** Re-run the action; resolves the new replacement text (already cleaned) or null. */
  onRetry: () => void;
}

/**
 * After an in-place AI replacement, show a Cursor-style inline review affordance:
 * the new region is highlighted, and a small ✓ Accept / ✗ Reject / ↻ Retry bar
 * floats above it. Accept keeps the text; Reject restores the original; Retry
 * delegates to the caller. Returns a disposer.
 */
export function showReview(
  editor: Editor,
  newText: string,
  original: string,
  startOffset: number,
  actions: ReviewActions,
): () => void {
  const maybeModel = editor.getModel();
  if (!maybeModel) return () => {};
  const model: monaco.editor.ITextModel = maybeModel;

  const highlight = editor.createDecorationsCollection();

  const node = document.createElement("div");
  node.className = "ai-review";
  const tooltips: Array<() => void> = [];
  const mkBtn = (cls: string, icon: string, label: string, title: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `ai-review__btn ${cls}`;
    b.innerHTML = `${icon}<span>${label}</span>`;
    b.addEventListener("mousedown", (e) => e.preventDefault());
    tooltips.push(attachTooltip(b, title));
    return b;
  };
  const acceptBtn = mkBtn("is-accept", ICON_ACCEPT, "Accept", "Keep this (Enter)");
  const rejectBtn = mkBtn("is-reject", ICON_REJECT, "Reject", "Revert to original (Esc)");
  const retryBtn = mkBtn("is-retry", ICON_RETRY, "Retry", "Generate again");
  node.append(acceptBtn, rejectBtn, retryBtn);

  let disposed = false;
  const startPos = model.getPositionAt(startOffset);
  let anchor: monaco.IPosition = startPos;

  // End position after `newText`, computed from its line structure (EOL-safe).
  const endPos = (): monaco.IPosition => {
    const lines = newText.split("\n");
    return lines.length === 1
      ? { lineNumber: startPos.lineNumber, column: startPos.column + lines[0].length }
      : { lineNumber: startPos.lineNumber + lines.length - 1, column: lines[lines.length - 1].length + 1 };
  };

  const widget: monaco.editor.IContentWidget = {
    allowEditorOverflow: true,
    getId: () => "smart-note.ai-review",
    getDomNode: () => node,
    getPosition: () =>
      disposed ? null : {
        position: anchor,
        preference: [
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
          monaco.editor.ContentWidgetPositionPreference.BELOW,
        ],
      },
  };

  function paint() {
    const to = endPos();
    anchor = startPos;
    highlight.set([
      {
        range: { startLineNumber: startPos.lineNumber, startColumn: startPos.column, endLineNumber: to.lineNumber, endColumn: to.column },
        options: { className: "ai-review-range", isWholeLine: false },
      },
    ]);
    editor.layoutContentWidget(widget);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    highlight.clear();
    editor.removeContentWidget(widget);
    keySub.dispose();
    tooltips.forEach((d) => d());
  }

  function accept() {
    dispose();
    editor.focus();
  }

  function reject() {
    const to = endPos();
    editor.executeEdits("ai-review-reject", [{
      range: { startLineNumber: startPos.lineNumber, startColumn: startPos.column, endLineNumber: to.lineNumber, endColumn: to.column },
      text: original,
      forceMoveMarkers: true,
    }]);
    dispose();
    editor.focus();
  }

  acceptBtn.addEventListener("click", (e) => { e.preventDefault(); accept(); });
  rejectBtn.addEventListener("click", (e) => { e.preventDefault(); reject(); });
  retryBtn.addEventListener("click", (e) => { e.preventDefault(); dispose(); actions.onRetry(); });

  // Enter accepts, Esc rejects — while the review is open.
  const keySub = editor.onKeyDown((e) => {
    if (disposed) return;
    if (e.keyCode === monaco.KeyCode.Enter && !e.shiftKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation(); accept();
    } else if (e.keyCode === monaco.KeyCode.Escape) {
      e.preventDefault(); e.stopPropagation(); reject();
    }
  });

  editor.addContentWidget(widget);
  paint();
  // Make sure the reviewed region (and thus the floating bar) is in view.
  editor.revealPositionInCenterIfOutsideViewport(startPos);

  return dispose;
}
