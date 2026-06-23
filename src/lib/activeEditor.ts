import type { editor } from "monaco-editor";

type MonacoEditor = editor.ICodeEditor;

const editors = new Set<MonacoEditor>();
let lastFocused: MonacoEditor | null = null;

export function registerEditor(ed: MonacoEditor) {
  editors.add(ed);
  lastFocused = ed;
  ed.onDidFocusEditorText(() => { lastFocused = ed; });
}

export function unregisterEditor(ed: MonacoEditor) {
  editors.delete(ed);
  if (lastFocused === ed) lastFocused = null;
}

/** The most recently focused editor (for "insert into note" from the chat panel). */
export function getActiveEditor(): MonacoEditor | null {
  if (lastFocused && editors.has(lastFocused)) return lastFocused;
  // Fall back to any registered editor.
  for (const ed of editors) return ed;
  return null;
}

/** Find the Monaco editor instance whose DOM contains the given target element. */
export function getEditorFromTarget(t: EventTarget | null): MonacoEditor | null {
  if (!(t instanceof Element)) return null;
  for (const ed of editors) {
    const node = ed.getDomNode();
    if (node && node.contains(t)) return ed;
  }
  return null;
}
