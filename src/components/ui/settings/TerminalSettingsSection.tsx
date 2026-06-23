import React from "react";
import { useTerminalPreferences } from "../../../store/selectors";
import { SettingRow } from "../SettingRow";
import { Slider } from "../Slider";
import { Toggle } from "../Toggle";
import { SegmentedControl } from "../SegmentedControl";
import { NumberStepper } from "../NumberStepper";
import { TERMINAL_CURSOR_STYLE_OPTIONS } from "./settingsConstants";
import type { TerminalCursorStyle } from "../../../types";

export const TerminalSettingsSection = React.memo(function TerminalSettingsSection() {
  const {
    terminalFontSize, setTerminalFontSize,
    terminalCursorStyle, setTerminalCursorStyle,
    terminalCursorBlink, setTerminalCursorBlink,
    terminalScrollback, setTerminalScrollback,
  } = useTerminalPreferences();

  return (
    <div className="flex flex-col gap-5">
      <h2 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>Terminal</h2>

      <SettingRow label="Font Size" description="Terminal font size">
        <Slider
          value={terminalFontSize} onChange={setTerminalFontSize}
          min={8} max={24} resetValue={13}
          formatValue={(v) => `${v}px`}
          aria-label="Terminal font size"
        />
      </SettingRow>
      <SettingRow label="Cursor Style" description="Shape of the terminal cursor">
        <SegmentedControl
          value={terminalCursorStyle}
          onChange={(v) => setTerminalCursorStyle(v as TerminalCursorStyle)}
          options={TERMINAL_CURSOR_STYLE_OPTIONS}
          aria-label="Terminal cursor style"
        />
      </SettingRow>
      <SettingRow label="Cursor Blink" description="Blink the terminal cursor">
        <Toggle value={terminalCursorBlink} onChange={setTerminalCursorBlink} />
      </SettingRow>
      <SettingRow label="Scrollback Lines" description="Number of lines kept in scroll history">
        <NumberStepper
          value={terminalScrollback} onChange={setTerminalScrollback}
          min={1000} max={50000} step={1000}
          aria-label="Terminal scrollback lines"
        />
      </SettingRow>
    </div>
  );
});
