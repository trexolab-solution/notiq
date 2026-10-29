import { describe, expect, it } from "vitest";
import { quickSearchComboError } from "./quickSearch";

const app = [{ key: "Ctrl+N", label: "New note" }, { key: "Ctrl+Shift+F", label: "Search in files" }];

describe("quickSearchComboError", () => {
  it("accepts a free combo with a modifier", () => {
    expect(quickSearchComboError("Ctrl+Alt+K", app, "Ctrl+Alt+L")).toBeNull();
    expect(quickSearchComboError("Alt+Shift+Space", app, "Ctrl+Alt+L")).toBeNull();
  });

  it("needs Ctrl, Alt or Cmd", () => {
    expect(quickSearchComboError("F5", app, "Ctrl+Alt+L")).toMatch(/Ctrl, Alt or Cmd/);
    expect(quickSearchComboError("Shift+K", app, "Ctrl+Alt+L")).toMatch(/Ctrl, Alt or Cmd/);
  });

  it("refuses app and panic shortcuts (case / spacing insensitive)", () => {
    expect(quickSearchComboError("Ctrl+N", app, "Ctrl+Alt+L")).toBe('Already used by "New note"');
    expect(quickSearchComboError("Ctrl+Shift+F", app, "Ctrl+Alt+L")).toBe('Already used by "Search in files"');
    expect(quickSearchComboError("Ctrl+Alt+L", app, "ctrl + alt + l")).toBe('Already used by "Panic lock"');
  });
});
