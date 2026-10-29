import React from "react";
import { useEditorPreferences } from "../../../store/selectors";
import { SettingRow } from "../SettingRow";
import { prefReset } from "./prefReset";
import { SettingsGroup } from "../SettingsGroup";
import { Slider } from "../Slider";
import { Toggle } from "../Toggle";
import { Select } from "../Select";
import { SegmentedControl } from "../SegmentedControl";
import {
  FONT_FAMILIES, EDITOR_MODES, AUTO_CLOSING_OPTIONS, RENDER_WHITESPACE_OPTIONS,
  LINE_HIGHLIGHT_OPTIONS, CURSOR_STYLE_OPTIONS, CURSOR_BLINKING_OPTIONS, TAB_SIZE_OPTIONS,
  SETTINGS_SELECT_STYLE,
} from "./settingsConstants";
import { EDITOR_INDEX, indexProps } from "./sectionIndexes";
import type {
  EditorMode, EditorCursorStyle, EditorCursorBlinking,
  AutoClosingBrackets, RenderWhitespace, RenderLineHighlight,
} from "../../../types";
import type { SettingMeta } from "../../../lib/settingsIndex";

const m = indexProps(EDITOR_INDEX);

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
    <div className="settings-section-body">
      <SettingsGroup id="editor.font" title="Font">
        <SettingRow {...m("editor.font.size")} {...prefReset("editorFontSize", editorFontSize, setEditorFontSize)}>
          <Slider
            value={editorFontSize} onChange={setEditorFontSize}
            min={8} max={32}
            formatValue={(v) => `${v}px`}
            aria-label="Editor font size"
          />
        </SettingRow>
        <SettingRow {...m("editor.font.family")} {...prefReset("fontFamily", fontFamily, setFontFamily)}>
          <Select
            value={fontFamily} onChange={setFontFamily}
            options={FONT_FAMILIES}
            triggerStyle={SETTINGS_SELECT_STYLE}
            aria-label="Editor font family"
          />
        </SettingRow>
        <SettingRow {...m("editor.font.letter-spacing")} {...prefReset("letterSpacing", letterSpacing, setLetterSpacing)}>
          <Slider
            value={letterSpacing} onChange={setLetterSpacing}
            min={0} max={1} step={0.1}
            formatValue={(v) => v.toFixed(1)}
            aria-label="Letter spacing"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="editor.display" title="Display" description="What the editor draws around your text.">
        <SettingRow {...m("editor.display.line-numbers")} {...prefReset("showLineNumbers", showLineNumbers, setShowLineNumbers)}>
          <Toggle value={showLineNumbers} onChange={setShowLineNumbers} aria-label="Line numbers" />
        </SettingRow>
        <SettingRow {...m("editor.display.word-wrap")} {...prefReset("wordWrap", wordWrap, setWordWrap)}>
          <Toggle value={wordWrap} onChange={setWordWrap} aria-label="Word wrap" />
        </SettingRow>
        <SettingRow {...m("editor.display.minimap")} {...prefReset("minimap", minimap, setMinimap)}>
          <Toggle value={minimap} onChange={setMinimap} aria-label="Minimap" />
        </SettingRow>
        <SettingRow {...m("editor.display.whitespace")} {...prefReset("renderWhitespace", renderWhitespace, setRenderWhitespace)}>
          <Select
            value={renderWhitespace}
            onChange={(v) => setRenderWhitespace(v as RenderWhitespace)}
            options={RENDER_WHITESPACE_OPTIONS}
            triggerStyle={SETTINGS_SELECT_STYLE}
            aria-label="Show whitespace"
          />
        </SettingRow>
        <SettingRow {...m("editor.display.line-highlight")} {...prefReset("renderLineHighlight", renderLineHighlight, setRenderLineHighlight)}>
          <Select
            value={renderLineHighlight}
            onChange={(v) => setRenderLineHighlight(v as RenderLineHighlight)}
            options={LINE_HIGHLIGHT_OPTIONS}
            triggerStyle={SETTINGS_SELECT_STYLE}
            aria-label="Current line highlight"
          />
        </SettingRow>
        <SettingRow {...m("editor.display.bracket-colors")} {...prefReset("bracketPairColorization", bracketPairColorization, setBracketPairColorization)}>
          <Toggle value={bracketPairColorization} onChange={setBracketPairColorization} aria-label="Bracket pair colors" />
        </SettingRow>
        <SettingRow {...m("editor.display.folding")} {...prefReset("folding", folding, setFolding)}>
          <Toggle value={folding} onChange={setFolding} aria-label="Code folding" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="editor.cursor" title="Cursor">
        <SettingRow {...m("editor.cursor.style")} {...prefReset("cursorStyle", cursorStyle, setCursorStyle)}>
          <Select
            value={cursorStyle} onChange={(v) => setCursorStyle(v as EditorCursorStyle)}
            options={CURSOR_STYLE_OPTIONS}
            triggerStyle={SETTINGS_SELECT_STYLE}
            aria-label="Cursor style"
          />
        </SettingRow>
        <SettingRow {...m("editor.cursor.blinking")} {...prefReset("cursorBlinking", cursorBlinking, setCursorBlinking)}>
          <Select
            value={cursorBlinking} onChange={(v) => setCursorBlinking(v as EditorCursorBlinking)}
            options={CURSOR_BLINKING_OPTIONS}
            triggerStyle={SETTINGS_SELECT_STYLE}
            aria-label="Cursor animation"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="editor.editing" title="Editing">
        <SettingRow {...m("editor.editing.default-mode")} {...prefReset("defaultEditorMode", defaultEditorMode, setDefaultEditorMode)}>
          <Select
            value={defaultEditorMode}
            onChange={(v) => setDefaultEditorMode(v as EditorMode)}
            options={EDITOR_MODES}
            triggerStyle={SETTINGS_SELECT_STYLE}
            aria-label="Default view for new notes"
          />
        </SettingRow>
        <SettingRow {...m("editor.editing.tab-size")} {...prefReset("tabSize", tabSize, setTabSize)}>
          <SegmentedControl
            value={String(tabSize)}
            onChange={(v) => setTabSize(Number(v))}
            options={TAB_SIZE_OPTIONS}
            aria-label="Tab size"
          />
        </SettingRow>
        <SettingRow {...m("editor.editing.auto-close")} {...prefReset("autoClosingBrackets", autoClosingBrackets, setAutoClosingBrackets)}>
          <Select
            value={autoClosingBrackets}
            onChange={(v) => setAutoClosingBrackets(v as AutoClosingBrackets)}
            options={AUTO_CLOSING_OPTIONS}
            triggerStyle={SETTINGS_SELECT_STYLE}
            aria-label="Auto-close brackets"
          />
        </SettingRow>
        <SettingRow {...m("editor.editing.format-on-paste")} {...prefReset("formatOnPaste", formatOnPaste, setFormatOnPaste)}>
          <Toggle value={formatOnPaste} onChange={setFormatOnPaste} aria-label="Format on paste" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="editor.scrolling" title="Scrolling">
        <SettingRow {...m("editor.scrolling.smooth")} {...prefReset("smoothScrolling", smoothScrolling, setSmoothScrolling)}>
          <Toggle value={smoothScrolling} onChange={setSmoothScrolling} aria-label="Smooth scrolling" />
        </SettingRow>
        <SettingRow {...m("editor.scrolling.speed")} {...prefReset("mouseWheelScrollSensitivity", mouseWheelScrollSensitivity, setMouseWheelScrollSensitivity)}>
          <Slider
            value={mouseWheelScrollSensitivity} onChange={setMouseWheelScrollSensitivity}
            min={0.5} max={5} step={0.5}
            formatValue={(v) => `${v.toFixed(1)}×`}
            aria-label="Scroll speed"
          />
        </SettingRow>
        <SettingRow {...m("editor.scrolling.past-end")} {...prefReset("scrollBeyondLastLine", scrollBeyondLastLine, setScrollBeyondLastLine)}>
          <Toggle value={scrollBeyondLastLine} onChange={setScrollBeyondLastLine} aria-label="Scroll past last line" />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = EDITOR_INDEX;
