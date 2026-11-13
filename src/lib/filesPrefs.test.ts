// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_FILES_PREFS, getFilesPrefs, sanitizeFilesPrefs, setFilesPrefs } from "./filesPrefs";

beforeEach(() => localStorage.clear());

describe("file manager preferences", () => {
  it("starts with the defaults", () => {
    expect(getFilesPrefs()).toEqual(DEFAULT_FILES_PREFS);
    expect(DEFAULT_FILES_PREFS).toMatchObject({ showHidden: false, openAction: "open", confirmDelete: true });
  });

  it("keeps a change and leaves the other values alone", () => {
    setFilesPrefs({ showHidden: true });
    setFilesPrefs({ sortKey: "size", sortDesc: true });
    expect(getFilesPrefs()).toMatchObject({ showHidden: true, sortKey: "size", sortDesc: true, confirmDelete: true });
  });

  it("ignores junk and clamps the font size", () => {
    expect(sanitizeFilesPrefs({ sortKey: "colour", showHidden: "yes", openAction: 3, editorFontSize: 400 }))
      .toMatchObject({ sortKey: "name", showHidden: false, openAction: "open", editorFontSize: 24 });
    expect(sanitizeFilesPrefs({ editorFontSize: 2 }).editorFontSize).toBe(10);
    expect(sanitizeFilesPrefs({ view: "tiles", gridSize: "huge" })).toMatchObject({ view: "list", gridSize: "medium" });
    expect(sanitizeFilesPrefs({ view: "grid", gridSize: "large" })).toMatchObject({ view: "grid", gridSize: "large" });
    expect(sanitizeFilesPrefs(null)).toEqual(DEFAULT_FILES_PREFS);
    localStorage.setItem("pref:filesPrefs", "{not json");
    expect(getFilesPrefs()).toEqual(DEFAULT_FILES_PREFS);
  });
});
