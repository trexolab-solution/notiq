import React from "react";
import { useEditorPreferences } from "../../../store/selectors";
import { SettingRow } from "../SettingRow";
import { Slider } from "../Slider";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import { SegmentedControl } from "../SegmentedControl";
import { SubHeading } from "./SubHeading";
import {
  FONT_FAMILIES, EDITOR_MODES, AUTO_CLOSING_OPTIONS, RENDER_WHITESPACE_OPTIONS,
  LINE_HIGHLIGHT_OPTIONS, CURSOR_STYLE_OPTIONS, CURSOR_BLINKING_OPTIONS, TAB_SIZE_OPTIONS,
} from "./settingsConstants";
import type {
  EditorMode, EditorCursorStyle, EditorCursorBlinking,
  AutoClosingBrackets, RenderWhitespace, RenderLineHighlight,
} from "../../../types";

export const EditorSettingsSection = React.memo(function EditorSettingsSection() {
  const {
    editorFontSize, setEditorFontSize,
    wordWrap, setWordWrap,
    showLineNumbers, setShowLineNumbers,
    defaultEditorMode, setDefaultEditorMode,
    fontFamily, setFontFamily,
    tabSize, setTabSize,
    minimap, setMinimap,
    bracketPairColorization, setBracketPairColorization,
    formatOnPaste, setFormatOnPaste,
    autoClosingBrackets, setAutoClosingBrackets,
    renderWhitespace, setRenderWhitespace,
    smoothScrolling, setSmoothScrolling,
    mouseWheelScrollSensitivity, setMouseWheelScrollSensitivity,
    scrollBeyondLastLine, setScrollBeyondLastLine,
    folding, setFolding,
    renderLineHighlight, setRenderLineHighlight,
    letterSpacing, setLetterSpacing,
    cursorStyle, setCursorStyle,
    cursorBlinking, setCursorBlinking,
  } = useEditorPreferences();

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>Editor</h2>

      {/* Font & Display */}
      <SubHeading>Font &amp; Display</SubHeading>
      <SettingRow label="Font Size" description="Editor font size (also Ctrl+Scroll)">
        <Slider
          value={editorFontSize} onChange={setEditorFontSize}
          min={8} max={32} resetValue={15}
          formatValue={(v) => `${v}px`}
          aria-label="Editor font size"
        />
      </SettingRow>
      <SettingRow label="Font Family" description="Monospace font for the editor">
        <Select
          value={fontFamily} onChange={setFontFamily}
          options={FONT_FAMILIES}
          aria-label="Font family"
        />
      </SettingRow>
      <SettingRow label="Letter Spacing" description="Space between characters">
        <Slider
          value={letterSpacing} onChange={setLetterSpacing}
          min={0} max={1} step={0.1} resetValue={0.2}
          formatValue={(v) => v.toFixed(1)}
          aria-label="Letter spacing"
        />
      </SettingRow>
      <SettingRow label="Line Numbers" description="Show line numbers in the editor">
        <Toggle value={showLineNumbers} onChange={setShowLineNumbers} />
      </SettingRow>
      <SettingRow label="Word Wrap" description="Wrap long lines at column edge">
        <Toggle value={wordWrap} onChange={setWordWrap} />
      </SettingRow>

      {/* Cursor */}
      <SubHeading>Cursor</SubHeading>
      <SettingRow label="Cursor Style" description="Shape of the editor cursor">
        <Select
          value={cursorStyle} onChange={(v) => setCursorStyle(v as EditorCursorStyle)}
          options={CURSOR_STYLE_OPTIONS}
          aria-label="Cursor style"
        />
      </SettingRow>
      <SettingRow label="Cursor Blinking" description="Cursor animation style">
        <Select
          value={cursorBlinking} onChange={(v) => setCursorBlinking(v as EditorCursorBlinking)}
          options={CURSOR_BLINKING_OPTIONS}
          aria-label="Cursor blinking"
        />
      </SettingRow>

      {/* Editing Behavior */}
      <SubHeading>Editing Behavior</SubHeading>
      <SettingRow label="Tab Size" description="Number of spaces per tab">
        <SegmentedControl
          value={String(tabSize)}
          onChange={(v) => setTabSize(Number(v))}
          options={TAB_SIZE_OPTIONS}
          aria-label="Tab size"
        />
      </SettingRow>
      <SettingRow label="Default Mode" description="Mode when a new note is created">
        <Select
          value={defaultEditorMode}
          onChange={(v) => setDefaultEditorMode(v as EditorMode)}
          options={EDITOR_MODES}
          aria-label="Default editor mode"
        />
      </SettingRow>
      <SettingRow label="Auto-Close Brackets" description="Automatically close brackets and quotes">
        <Select
          value={autoClosingBrackets}
          onChange={(v) => setAutoClosingBrackets(v as AutoClosingBrackets)}
          options={AUTO_CLOSING_OPTIONS}
          aria-label="Auto-closing brackets"
        />
      </SettingRow>
      <SettingRow label="Format On Paste" description="Auto-format pasted code">
        <Toggle value={formatOnPaste} onChange={setFormatOnPaste} />
      </SettingRow>
      <SettingRow label="Bracket Colors" description="Colorize matching bracket pairs">
        <Toggle value={bracketPairColorization} onChange={setBracketPairColorization} />
      </SettingRow>

      {/* Display */}
      <SubHeading>Display</SubHeading>
      <SettingRow label="Minimap" description="Show code overview minimap">
        <Toggle value={minimap} onChange={setMinimap} />
      </SettingRow>
      <SettingRow label="Render Whitespace" description="Show whitespace characters">
        <Select
          value={renderWhitespace}
          onChange={(v) => setRenderWhitespace(v as RenderWhitespace)}
          options={RENDER_WHITESPACE_OPTIONS}
          aria-label="Render whitespace"
        />
      </SettingRow>
      <SettingRow label="Line Highlight" description="Highlight the current line">
        <Select
          value={renderLineHighlight}
          onChange={(v) => setRenderLineHighlight(v as RenderLineHighlight)}
          options={LINE_HIGHLIGHT_OPTIONS}
          aria-label="Line highlight"
        />
      </SettingRow>
      <SettingRow label="Smooth Scrolling" description="Animate scroll movements">
        <Toggle value={smoothScrolling} onChange={setSmoothScrolling} />
      </SettingRow>
      <SettingRow label="Scroll Speed" description="Mouse wheel scroll sensitivity">
        <Slider
          value={mouseWheelScrollSensitivity} onChange={setMouseWheelScrollSensitivity}
          min={0.5} max={5} step={0.5} resetValue={1}
          formatValue={(v) => `${v.toFixed(1)}×`}
          aria-label="Mouse wheel scroll sensitivity"
        />
      </SettingRow>
      <SettingRow label="Scroll Past End" description="Allow scrolling beyond the last line">
        <Toggle value={scrollBeyondLastLine} onChange={setScrollBeyondLastLine} />
      </SettingRow>
      <SettingRow label="Code Folding" description="Enable collapsible code regions">
        <Toggle value={folding} onChange={setFolding} />
      </SettingRow>
    </div>
  );
});
