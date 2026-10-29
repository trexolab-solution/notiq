import { describe, expect, it, vi } from "vitest";
import type { SettingMeta } from "./settingsIndex";
import { settingsCommandsFor, PALETTE_SETTINGS_LIMIT } from "./settingsCommands";

const S: SettingMeta[] = [
  { id: "editor.text.size", section: "editor", group: "Text", label: "Font size" },
  { id: "terminal.text.size", section: "terminal", label: "Terminal font size" },
  { id: "vault.lock.idle", section: "vault", group: "Locking", label: "Lock after idle" },
];

describe("settingsCommandsFor (command palette)", () => {
  it("lists nothing for an empty query", () => {
    expect(settingsCommandsFor("", S, vi.fn())).toEqual([]);
  });

  it("labels entries Settings › Section › Label, ranked, and opens the setting", () => {
    const open = vi.fn();
    const cmds = settingsCommandsFor("font", S, open);
    expect(cmds.map((c) => c.label)).toEqual([
      "Settings › Editor › Font size",
      "Settings › Terminal › Terminal font size",
    ]);
    expect(cmds[0]).toMatchObject({ id: "setting:editor.text.size", hint: "Text" });
    cmds[1].run();
    expect(open).toHaveBeenCalledWith("terminal", "terminal.text.size");
  });

  it("caps the number of entries", () => {
    const many: SettingMeta[] = Array.from({ length: 40 }, (_, i) => ({ id: `general.x.${i}`, section: "general", label: `Option ${i}` }));
    expect(settingsCommandsFor("option", many, vi.fn())).toHaveLength(PALETTE_SETTINGS_LIMIT);
    expect(settingsCommandsFor("option", many, vi.fn(), 3)).toHaveLength(3);
  });
});
