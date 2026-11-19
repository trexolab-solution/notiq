import { describe, expect, it } from "vitest";
import { comboFromEvent, hasRequiredModifier, normalizeCombo } from "./shortcutCombo";

const ev = (o: Partial<KeyboardEvent>) => ({ key: "", code: "", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...o }) as KeyboardEvent;

describe("comboFromEvent", () => {
  it("returns null when only modifiers are held", () => {
    for (const key of ["Control", "Alt", "Shift", "Meta", "AltGraph"]) expect(comboFromEvent(ev({ key }))).toBeNull();
  });
  it("uses the physical key code for letters and digits (layout/modifier independent)", () => {
    expect(comboFromEvent(ev({ key: "ł", code: "KeyL", ctrlKey: true, altKey: true }))).toBe("Ctrl+Alt+L");
    expect(comboFromEvent(ev({ key: "!", code: "Digit1", ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+1");
  });
  it("names space, uppercases single chars and keeps named keys", () => {
    expect(comboFromEvent(ev({ key: " ", code: "Space", ctrlKey: true }))).toBe("Ctrl+Space");
    expect(comboFromEvent(ev({ key: ",", code: "Comma", ctrlKey: true }))).toBe("Ctrl+,");
    expect(comboFromEvent(ev({ key: "F5", code: "F5" }))).toBe("F5");
  });
  it("orders modifiers Ctrl, Alt, Shift, Meta", () => {
    expect(comboFromEvent(ev({ key: "ArrowUp", code: "ArrowUp", metaKey: true, shiftKey: true, altKey: true, ctrlKey: true })))
      .toBe("Ctrl+Alt+Shift+Meta+ArrowUp");
  });
});

describe("hasRequiredModifier", () => {
  it("accepts Ctrl/Alt/Meta combos", () => {
    expect(hasRequiredModifier("Ctrl+K")).toBe(true);
    expect(hasRequiredModifier("Shift+Alt+K")).toBe(true);
    expect(hasRequiredModifier("Meta+K")).toBe(true);
  });
  it("accepts F1-F12 alone but not F13 or bare keys", () => {
    expect(hasRequiredModifier("F1")).toBe(true);
    expect(hasRequiredModifier("F12")).toBe(true);
    expect(hasRequiredModifier("Shift+F9")).toBe(true);
    expect(hasRequiredModifier("F13")).toBe(false);
    expect(hasRequiredModifier("K")).toBe(false);
    expect(hasRequiredModifier("Shift+K")).toBe(false);
  });
});

describe("normalizeCombo", () => {
  it("lowercases, strips whitespace and maps the shift glyph", () => {
    expect(normalizeCombo("Ctrl + ⇧ + P")).toBe("ctrl+shift+p");
  });
});
