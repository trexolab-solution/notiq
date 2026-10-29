import React from "react";
import { useTerminalPreferences } from "../../../store/selectors";
import { SettingRow } from "../SettingRow";
import { prefReset } from "./prefReset";
import { SettingsGroup } from "../SettingsGroup";
import { Slider } from "../Slider";
import { Toggle } from "../Toggle";
import { SegmentedControl } from "../SegmentedControl";
import { NumberStepper } from "../NumberStepper";
import { TERMINAL_CURSOR_STYLE_OPTIONS, TERMINAL_POSITION_OPTIONS } from "./settingsConstants";
import { TERMINAL_INDEX, indexProps } from "./sectionIndexes";
import type { TerminalCursorStyle, TerminalLayout } from "../../../types";
import type { SettingMeta } from "../../../lib/settingsIndex";

const m = indexProps(TERMINAL_INDEX);

export const TerminalSettingsSection = React.memo(function TerminalSettingsSection() {
  const {
    terminalFontSize, setTerminalFontSize,
    terminalCursorStyle, setTerminalCursorStyle,
    terminalCursorBlink, setTerminalCursorBlink,
    terminalScrollback, setTerminalScrollback,
    terminalLayout, setTerminalLayout,
  } = useTerminalPreferences();

  return (
    <div className="settings-section-body">
      <SettingsGroup id="terminal.font" title="Font">
        <SettingRow {...m("terminal.font.size")} {...prefReset("terminalFontSize", terminalFontSize, setTerminalFontSize)}>
          <Slider
            value={terminalFontSize} onChange={setTerminalFontSize}
            min={8} max={24}
            formatValue={(v) => `${v}px`}
            aria-label="Terminal font size"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="terminal.cursor" title="Cursor">
        <SettingRow {...m("terminal.cursor.style")} {...prefReset("terminalCursorStyle", terminalCursorStyle, setTerminalCursorStyle)}>
          <SegmentedControl
            value={terminalCursorStyle}
            onChange={(v) => setTerminalCursorStyle(v as TerminalCursorStyle)}
            options={TERMINAL_CURSOR_STYLE_OPTIONS}
            aria-label="Terminal cursor style"
          />
        </SettingRow>
        <SettingRow {...m("terminal.cursor.blink")} {...prefReset("terminalCursorBlink", terminalCursorBlink, setTerminalCursorBlink)}>
          <Toggle value={terminalCursorBlink} onChange={setTerminalCursorBlink} aria-label="Blinking terminal cursor" />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup id="terminal.behaviour" title="Behaviour">
        <SettingRow {...m("terminal.behaviour.scrollback")} {...prefReset("terminalScrollback", terminalScrollback, setTerminalScrollback)}>
          <NumberStepper
            value={terminalScrollback} onChange={setTerminalScrollback}
            min={1000} max={50000} step={1000}
            formatValue={(v) => `${v.toLocaleString()} lines`}
            aria-label="Terminal scrollback lines"
          />
        </SettingRow>
        <SettingRow {...m("terminal.behaviour.position")} {...prefReset("terminalLayout", terminalLayout, setTerminalLayout)}>
          <SegmentedControl
            value={terminalLayout}
            onChange={(v) => setTerminalLayout(v as TerminalLayout)}
            options={TERMINAL_POSITION_OPTIONS}
            aria-label="Terminal panel position"
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
});

/** Every searchable setting this section renders (see lib/settingsIndex.ts). */
export const SETTINGS_INDEX: SettingMeta[] = TERMINAL_INDEX;
