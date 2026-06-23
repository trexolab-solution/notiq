import type * as monacoNs from "monaco-editor";
import { subscribeBusyDelayed } from "./activity";

type Editor = monacoNs.editor.ICodeEditor;

const WIDGET_ID = "smart-note.ai.status-chip";

/**
 * A calm "AI is working" status chip pinned to the editor's bottom-right corner
 * (a Monaco overlay widget, so it floats over the editor and never shifts text).
 * Used in windows without a status bar — primarily sticky notes; the main window
 * shows the equivalent indicator in its status bar instead.
 *
 * Visibility timing (delayed show + minimum visible time) lives in
 * `subscribeBusyDelayed`, so fast suggestions never flash the chip and it fades
 * in/out smoothly. All motion is CSS (`.ai-status-chip` in themes.css).
 */
export function attachAiLoader(editor: Editor, monaco: typeof monacoNs): () => void {
  // Build the chip DOM once: a small spinner + a muted "Thinking…" label.
  const node = document.createElement("div");
  node.className = "ai-status-chip";
  node.setAttribute("aria-hidden", "true");
  const spinner = document.createElement("span");
  spinner.className = "ai-status-chip__spinner";
  const label = document.createElement("span");
  label.className = "ai-status-chip__label";
  label.textContent = "Thinking…";
  node.appendChild(spinner);
  node.appendChild(label);

  const widget: monacoNs.editor.IOverlayWidget = {
    getId: () => WIDGET_ID,
    getDomNode: () => node,
    // BOTTOM_RIGHT_CORNER keeps the chip out of the typing flow; CSS margin
    // insets it from the editor edges so it never hugs the scrollbar.
    getPosition: () => ({
      preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER,
    }),
  };
  editor.addOverlayWidget(widget);

  const unsubscribe = subscribeBusyDelayed((visible) => {
    node.classList.toggle("is-visible", visible);
  });

  return () => {
    unsubscribe();
    try { editor.removeOverlayWidget(widget); } catch { /* editor already disposed */ }
  };
}
