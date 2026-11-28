import type { editor } from "monaco-editor";

/** Preference values consumed by `buildDynamicOptions`. */
export interface EditorPrefs {
  editorFontSize: number;
  wordWrap: boolean;
  showLineNumbers: boolean;
  fontFamily: string;
  letterSpacing: number;
  tabSize: number;
  minimap: boolean;
  bracketPairColorization: boolean;
  formatOnPaste: boolean;
  autoClosingBrackets: string;
  renderWhitespace: string;
  smoothScrolling: boolean;
  mouseWheelScrollSensitivity: number;
  scrollBeyondLastLine: boolean;
  folding: boolean;
  renderLineHighlight: string;
  cursorStyle: string;
  cursorBlinking: string;
}

/** Build the subset of Monaco options that depend on user preferences. */
export function buildDynamicOptions(p: EditorPrefs): editor.IStandaloneEditorConstructionOptions {
  return {
    fontSize: p.editorFontSize,
    lineHeight: Math.round(p.editorFontSize * 1.7),
    fontFamily: p.fontFamily,
    letterSpacing: p.letterSpacing,
    wordWrap: p.wordWrap ? "on" : "off",
    lineNumbers: p.showLineNumbers ? "on" : "off",
    lineDecorationsWidth: p.showLineNumbers ? 10 : 0,
    lineNumbersMinChars: p.showLineNumbers ? 4 : 0,
    tabSize: p.tabSize,
    minimap: { enabled: p.minimap },
    bracketPairColorization: { enabled: p.bracketPairColorization },
    formatOnPaste: p.formatOnPaste,
    autoClosingBrackets: p.autoClosingBrackets as editor.IStandaloneEditorConstructionOptions["autoClosingBrackets"],
    renderWhitespace: p.renderWhitespace as editor.IStandaloneEditorConstructionOptions["renderWhitespace"],
    smoothScrolling: p.smoothScrolling,
    mouseWheelScrollSensitivity: p.mouseWheelScrollSensitivity,
    scrollBeyondLastLine: p.scrollBeyondLastLine,
    folding: p.folding,
    renderLineHighlight: p.renderLineHighlight as editor.IStandaloneEditorConstructionOptions["renderLineHighlight"],
    cursorStyle: p.cursorStyle as editor.IStandaloneEditorConstructionOptions["cursorStyle"],
    cursorBlinking: p.cursorBlinking as editor.IStandaloneEditorConstructionOptions["cursorBlinking"],
  };
}

/**
 * The editor's own suggestions, or room for AI's. While AI suggests as you type, the native pop-up and word matching
 * stay off (Monaco hides ghost text whenever its suggest list has a highlighted item); otherwise they are on. Words
 * come from the open document only, never from other tabs, so a vault note's words can't show up elsewhere.
 * Trigger characters (".") and Ctrl+Space work either way.
 */
export function suggestionOptions(aiTypesAlong: boolean): editor.IStandaloneEditorConstructionOptions {
  return aiTypesAlong
    ? { quickSuggestions: false, wordBasedSuggestions: "off" }
    : { quickSuggestions: { other: true, comments: false, strings: false }, wordBasedSuggestions: "currentDocument" };
}

/** Static Monaco options that never change across preference updates. */
export const STATIC_EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  fontLigatures: true,
  wordWrapColumn: 88,
  padding: { top: 4, bottom: 20 },
  glyphMargin: false,
  occurrencesHighlight: "off",
  selectionHighlight: false,
  contextmenu: false,
  insertSpaces: true,
  fixedOverflowWidgets: true,
  scrollBeyondLastLine: true,
  scrollbar: {
    vertical: "visible",
    horizontal: "hidden",
    verticalScrollbarSize: 10, // the app's scrollbar lane (styles/scrollbars.css)
    useShadows: false,
  },
  foldingStrategy: "auto",
  showFoldingControls: "mouseover",
  foldingHighlight: true,
  foldingMaximumRegions: 5000,
  guides: {
    indentation: true,
    bracketPairs: "active",
    bracketPairsHorizontal: "active",
    highlightActiveIndentation: true,
    highlightActiveBracketPair: true,
  },
  inlineSuggest: { enabled: true },
  suggestOnTriggerCharacters: true,
  acceptSuggestionOnEnter: "smart",
  tabCompletion: "on",
  snippetSuggestions: "inline",
  suggestSelection: "first",
  suggest: {
    preview: true,
    showWords: true,
    showSnippets: true,
    snippetsPreventQuickSuggestions: false,
    showIcons: true,
  },
  autoClosingQuotes: "always",
  autoIndent: "full",
  cursorSmoothCaretAnimation: "on",
  cursorWidth: 2,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  automaticLayout: true,
};
