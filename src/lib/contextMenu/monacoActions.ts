// Clipboard / history / selection actions for a Monaco editor, shared by the main
// window's editor menu and the sticky-note window.
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { editor as MonacoEditor } from "monaco-editor";
import type { EditActions, EditState } from "./items";

export function monacoEditState(ed: MonacoEditor.ICodeEditor): EditState {
  const sel = ed.getSelection();
  const model = ed.getModel();
  return {
    hasSelection: sel ? !sel.isEmpty() : false,
    readOnly: !!ed.getRawOptions().readOnly,
    isEmpty: !model || model.getValueLength() === 0,
  };
}

export function monacoEditActions(ed: MonacoEditor.ICodeEditor): Required<EditActions> {
  return {
    cut: async () => {
      const s = ed.getSelection();
      const model = ed.getModel();
      if (s && model && !s.isEmpty()) {
        await writeText(model.getValueInRange(s));
        ed.executeEdits("ctx-cut", [{ range: s, text: "", forceMoveMarkers: true }]);
      }
      ed.focus();
    },
    copy: async () => {
      const s = ed.getSelection();
      const model = ed.getModel();
      if (s && model && !s.isEmpty()) await writeText(model.getValueInRange(s));
      ed.focus();
    },
    paste: async () => {
      const text = await readText().catch(() => "");
      ed.focus();
      if (text) ed.trigger("ctx-paste", "type", { text });
    },
    undo: () => { ed.trigger("ctx-menu", "undo", null); ed.focus(); },
    redo: () => { ed.trigger("ctx-menu", "redo", null); ed.focus(); },
    selectAll: () => {
      const model = ed.getModel();
      if (model) ed.setSelection(model.getFullModelRange());
      ed.focus();
    },
  };
}
