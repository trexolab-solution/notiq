import { describe, expect, it, vi } from "vitest";
import type { SettingMeta } from "./settingsIndex";

// The registry aggregates every section module (which pull in the store / Tauri); stub them so the
// search function itself can be exercised with injected data.
for (const m of [
  "GeneralSection", "EditorSettingsSection", "AISettingsSection", "VaultSection", "TerminalSettingsSection",
  "AppearanceSection", "ShortcutsSection", "UpdatesSection", "AboutSection",
]) vi.doMock(`../components/ui/settings/${m}`, () => ({ SETTINGS_INDEX: [] }));

const { rankSettings, sectionMatchCounts, settingMatches, visibleSections } = await import("./settingsSearch");
const { searchSettings } = await import("./settingsRegistry");

const S: SettingMeta[] = [
  { id: "general.startup.launch", section: "general", group: "Startup", label: "Launch at login", keywords: ["autostart"] },
  { id: "editor.text.font", section: "editor", group: "Text", label: "Font family", description: "The editor typeface" },
  { id: "editor.text.size", section: "editor", group: "Text", label: "Font size" },
  { id: "editor.view.minimap", section: "editor", group: "View", label: "Show minimap", description: "A zoomed-out map of the font" },
  { id: "appearance.theme", section: "appearance", group: "Theme", label: "Color theme", keywords: ["dark", "light"] },
  { id: "terminal.font", section: "terminal", group: "Text", label: "Terminal font size" },
  { id: "about.version", section: "about", label: "Version" },
];
const ids = (xs: SettingMeta[]) => xs.map((x) => x.id);

describe("rankSettings", () => {
  it("returns nothing for an empty / blank query", () => {
    expect(rankSettings(S, "")).toEqual([]);
    expect(rankSettings(S, "   ")).toEqual([]);
  });

  it("ranks label starts-with > label contains > description/keywords", () => {
    expect(ids(rankSettings(S, "font"))).toEqual([
      "editor.text.font", "editor.text.size",  // label starts with "font" (section order, then index order)
      "terminal.font",                         // label contains "font"
      "editor.view.minimap",                   // only the description mentions it
    ]);
  });

  it("matches multi-word queries across fields, ranking all-words-in-label above the rest", () => {
    expect(ids(rankSettings(S, "size font"))).toEqual(["editor.text.size", "terminal.font"]);
    expect(ids(rankSettings(S, "editor typeface"))).toEqual(["editor.text.font"]);
  });

  it("matches keywords, section labels and groups, case- and accent-insensitively", () => {
    expect(ids(rankSettings(S, "DARK"))).toEqual(["appearance.theme"]);
    expect(ids(rankSettings(S, "autostárt"))).toEqual(["general.startup.launch"]);
    expect(ids(rankSettings(S, "appearance"))).toEqual(["appearance.theme"]);
    expect(ids(rankSettings(S, "startup"))).toEqual(["general.startup.launch"]);
  });

  it("is stable by section order for equal ranks, regardless of input order", () => {
    const shuffled = [S[5], S[2], S[1]];
    expect(ids(rankSettings(shuffled, "font"))).toEqual(["editor.text.size", "editor.text.font", "terminal.font"]);
  });

  it("honours the limit", () => {
    expect(ids(rankSettings(S, "font", 2))).toEqual(["editor.text.font", "editor.text.size"]);
  });
});

describe("searchSettings (registry)", () => {
  it("searches the injected source", () => {
    expect(ids(searchSettings("theme", undefined, S))).toEqual(["appearance.theme"]);
    expect(searchSettings("font", 1, S)).toHaveLength(1);
  });

  it("searches ALL_SETTINGS by default (empty here, so no results)", () => {
    expect(searchSettings("font")).toEqual([]);
  });
});

describe("section visibility", () => {
  it("counts matches per section", () => {
    const c = sectionMatchCounts(S, "font");
    expect(c.editor).toBe(3);
    expect(c.terminal).toBe(1);
    expect(c.general).toBe(0);
    expect(Object.keys(c)).toHaveLength(9);
  });

  it("shows everything for an empty query", () => {
    expect(visibleSections(S, " ").size).toBe(9);
  });

  it("hides indexed sections without a match but keeps unindexed ones", () => {
    const v = visibleSections(S, "font");
    expect(v.has("editor")).toBe(true);
    expect(v.has("terminal")).toBe(true);
    expect(v.has("general")).toBe(false);    // indexed, no match
    expect(v.has("appearance")).toBe(false); // indexed, no match
    expect(v.has("vault")).toBe(true);       // nothing indexed → can't tell, keep it
  });

  it("settingMatches uses the section label", () => {
    expect(settingMatches(S[6], "about")).toBe(true);
    expect(settingMatches(S[6], "general")).toBe(false);
  });
});
