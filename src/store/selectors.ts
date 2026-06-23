import { useShallow } from "zustand/shallow";
import { useAppStore } from "./index";

/** Grouped selector for all editor preference values + setters (for SettingsModal). */
export function useEditorPreferences() {
  return useAppStore(
    useShallow((s) => ({
      editorFontSize:         s.editorFontSize,
      setEditorFontSize:      s.setEditorFontSize,
      wordWrap:               s.wordWrap,
      setWordWrap:            s.setWordWrap,
      showLineNumbers:        s.showLineNumbers,
      setShowLineNumbers:     s.setShowLineNumbers,
      defaultEditorMode:      s.defaultEditorMode,
      setDefaultEditorMode:   s.setDefaultEditorMode,
      fontFamily:             s.fontFamily,
      setFontFamily:          s.setFontFamily,
      tabSize:                s.tabSize,
      setTabSize:             s.setTabSize,
      minimap:                s.minimap,
      setMinimap:             s.setMinimap,
      bracketPairColorization: s.bracketPairColorization,
      setBracketPairColorization: s.setBracketPairColorization,
      formatOnPaste:          s.formatOnPaste,
      setFormatOnPaste:       s.setFormatOnPaste,
      autoClosingBrackets:    s.autoClosingBrackets,
      setAutoClosingBrackets: s.setAutoClosingBrackets,
      renderWhitespace:       s.renderWhitespace,
      setRenderWhitespace:    s.setRenderWhitespace,
      smoothScrolling:        s.smoothScrolling,
      setSmoothScrolling:     s.setSmoothScrolling,
      mouseWheelScrollSensitivity:    s.mouseWheelScrollSensitivity,
      setMouseWheelScrollSensitivity: s.setMouseWheelScrollSensitivity,
      scrollBeyondLastLine:   s.scrollBeyondLastLine,
      setScrollBeyondLastLine: s.setScrollBeyondLastLine,
      folding:                s.folding,
      setFolding:             s.setFolding,
      renderLineHighlight:    s.renderLineHighlight,
      setRenderLineHighlight: s.setRenderLineHighlight,
      letterSpacing:          s.letterSpacing,
      setLetterSpacing:       s.setLetterSpacing,
      cursorStyle:            s.cursorStyle,
      setCursorStyle:         s.setCursorStyle,
      cursorBlinking:         s.cursorBlinking,
      setCursorBlinking:      s.setCursorBlinking,
    })),
  );
}

/** Grouped selector for terminal preference values + setters (for SettingsModal). */
export function useTerminalPreferences() {
  return useAppStore(
    useShallow((s) => ({
      terminalFontSize:       s.terminalFontSize,
      setTerminalFontSize:    s.setTerminalFontSize,
      terminalCursorStyle:    s.terminalCursorStyle,
      setTerminalCursorStyle: s.setTerminalCursorStyle,
      terminalCursorBlink:    s.terminalCursorBlink,
      setTerminalCursorBlink: s.setTerminalCursorBlink,
      terminalScrollback:     s.terminalScrollback,
      setTerminalScrollback:  s.setTerminalScrollback,
      terminalLayout:         s.terminalLayout,
      setTerminalLayout:      s.setTerminalLayout,
    })),
  );
}

/** Grouped selector for AI / Autocomplete preference values + setters. */
export function useAIPreferences() {
  return useAppStore(
    useShallow((s) => ({
      aiEnabled:                s.aiEnabled,
      setAiEnabled:             s.setAiEnabled,
      aiProvider:               s.aiProvider,
      setAiProvider:            s.setAiProvider,
      aiModel:                  s.aiModel,
      setAiModel:               s.setAiModel,
      aiAutocompleteEnabled:    s.aiAutocompleteEnabled,
      setAiAutocompleteEnabled: s.setAiAutocompleteEnabled,
      aiTriggerMode:            s.aiTriggerMode,
      setAiTriggerMode:         s.setAiTriggerMode,
      aiDebounceMs:             s.aiDebounceMs,
      setAiDebounceMs:          s.setAiDebounceMs,
      aiContextLines:           s.aiContextLines,
      setAiContextLines:        s.setAiContextLines,
      aiOnboarded:              s.aiOnboarded,
      setAiOnboarded:           s.setAiOnboarded,
    })),
  );
}

/** Read-only editor prefs used by MonacoMarkdownEditor (+ setEditorFontSize for Ctrl+scroll). */
export function useMonacoEditorPreferences() {
  return useAppStore(
    useShallow((s) => ({
      editorFontSize:         s.editorFontSize,
      setEditorFontSize:      s.setEditorFontSize,
      wordWrap:               s.wordWrap,
      showLineNumbers:        s.showLineNumbers,
      fontFamily:             s.fontFamily,
      letterSpacing:          s.letterSpacing,
      tabSize:                s.tabSize,
      minimap:                s.minimap,
      bracketPairColorization: s.bracketPairColorization,
      formatOnPaste:          s.formatOnPaste,
      autoClosingBrackets:    s.autoClosingBrackets,
      renderWhitespace:       s.renderWhitespace,
      smoothScrolling:        s.smoothScrolling,
      mouseWheelScrollSensitivity: s.mouseWheelScrollSensitivity,
      scrollBeyondLastLine:   s.scrollBeyondLastLine,
      folding:                s.folding,
      renderLineHighlight:    s.renderLineHighlight,
      cursorStyle:            s.cursorStyle,
      cursorBlinking:         s.cursorBlinking,
    })),
  );
}
