import { describe, it, expect } from "vitest";
import { searchNotes } from "./searchNotes";
import type { Tab } from "../types";

/** Minimal Tab factory — only the fields searchNotes reads need to be real. */
function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "t1",
    kind: "note",
    title: "Untitled",
    content: "",
    isDirty: false,
    cursorPosition: { line: 1, column: 1 },
    scrollPosition: 0,
    editorMode: "split",
    isPinned: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("searchNotes", () => {
  it("returns nothing for an empty / whitespace query", () => {
    const tabs = [makeTab({ content: "hello world" })];
    expect(searchNotes(tabs, "")).toEqual([]);
    expect(searchNotes(tabs, "   ")).toEqual([]);
  });

  it("matches case-insensitively and reports 1-based line numbers", () => {
    const tab = makeTab({
      id: "a",
      title: "Notes",
      content: "first line\nThe Quick Fox\nlast line",
    });
    const res = searchNotes([tab], "quick");
    expect(res).toHaveLength(1);
    expect(res[0].tabId).toBe("a");
    expect(res[0].matches).toEqual([{ line: 2, lineText: "The Quick Fox" }]);
  });

  it("returns one match row per matching line", () => {
    const tab = makeTab({ content: "bug here\nok\nanother bug\nbug again" });
    const res = searchNotes([tab], "bug");
    expect(res[0].matches.map((m) => m.line)).toEqual([1, 3, 4]);
  });

  it("excludes notes with no match", () => {
    const tabs = [
      makeTab({ id: "a", content: "alpha" }),
      makeTab({ id: "b", content: "beta" }),
    ];
    const res = searchNotes(tabs, "alpha");
    expect(res.map((r) => r.tabId)).toEqual(["a"]);
  });

  it("skips whiteboard tabs and empty notes", () => {
    const tabs = [
      makeTab({ id: "wb", kind: "whiteboard", content: "match" }),
      makeTab({ id: "empty", content: "" }),
      makeTab({ id: "note", content: "match" }),
    ];
    const res = searchNotes(tabs, "match");
    expect(res.map((r) => r.tabId)).toEqual(["note"]);
  });

  it("caps matches per note and flags truncation", () => {
    const content = Array.from({ length: 10 }, () => "needle").join("\n");
    const tab = makeTab({ content });
    const res = searchNotes([tab], "needle", { maxPerNote: 3 });
    expect(res[0].matches).toHaveLength(3);
    expect(res[0].truncated).toBe(true);
  });

  it("does not flag truncation when under the cap", () => {
    const tab = makeTab({ content: "needle\nneedle" });
    const res = searchNotes([tab], "needle", { maxPerNote: 5 });
    expect(res[0].truncated).toBe(false);
  });

  it("falls back to 'Untitled' for a blank title", () => {
    const tab = makeTab({ title: "", content: "hi" });
    expect(searchNotes([tab], "hi")[0].title).toBe("Untitled");
  });
});
