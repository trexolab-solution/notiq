import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import { isContentTab, isNoteTab, isSettingsTab, normalizeSettingsTabs, SETTINGS_TAB_TITLE } from "./tabKinds";

const tab = (over: Partial<Tab>): Tab => ({
  id: over.id ?? "t", kind: "note", title: "T", content: "", isDirty: false,
  cursorPosition: { line: 1, column: 1 }, scrollPosition: 0, editorMode: "split",
  createdAt: 0, updatedAt: 0, isPinned: false, ...over,
});

describe("tab kind helpers", () => {
  it("treats notes and whiteboards as content tabs, Settings as not", () => {
    expect(isContentTab(tab({ kind: "note" }))).toBe(true);
    expect(isContentTab(tab({ kind: "whiteboard" }))).toBe(true);
    expect(isContentTab(tab({ kind: "settings" }))).toBe(false);
    expect(isContentTab(undefined)).toBe(false);
    expect(isContentTab(null)).toBe(false);
  });

  it("identifies the Settings tab and plain notes", () => {
    expect(isSettingsTab(tab({ kind: "settings" }))).toBe(true);
    expect(isSettingsTab(tab({ kind: "note" }))).toBe(false);
    expect(isSettingsTab(undefined)).toBe(false);
    expect(isNoteTab(tab({ kind: "note" }))).toBe(true);
    expect(isNoteTab(tab({ kind: "whiteboard" }))).toBe(false);
    expect(isNoteTab(tab({ kind: "settings" }))).toBe(false);
  });
});

describe("normalizeSettingsTabs (session restore)", () => {
  it("keeps only the first Settings tab and resets its invariants", () => {
    const out = normalizeSettingsTabs([
      tab({ id: "a" }),
      tab({ id: "s1", kind: "settings", title: "Renamed", content: "junk", isDirty: true, filePath: "C:/x.md", scrollPosition: 420 }),
      tab({ id: "b", kind: "whiteboard" }),
      tab({ id: "s2", kind: "settings" }),
    ]);
    expect(out.map((t) => t.id)).toEqual(["a", "s1", "b"]);
    const s = out[1];
    expect(s).toMatchObject({ title: SETTINGS_TAB_TITLE, content: "", isDirty: false, filePath: undefined, scrollPosition: 420 });
  });

  it("leaves sessions without a Settings tab untouched", () => {
    const tabs = [tab({ id: "a" }), tab({ id: "b", kind: "whiteboard" })];
    const out = normalizeSettingsTabs(tabs);
    expect(out).toEqual(tabs);
    expect(out[0]).toBe(tabs[0]);
  });
});
