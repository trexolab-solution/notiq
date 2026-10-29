import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SectionId, SettingMeta } from "../../../lib/settingsIndex";
import {
  GENERAL_INDEX, EDITOR_INDEX, TERMINAL_INDEX, APPEARANCE_INDEX, SHORTCUTS_INDEX, UPDATES_INDEX, ABOUT_INDEX,
  shortcutId, indexProps,
} from "./sectionIndexes";
import { ALL_SHORTCUTS, SHORTCUT_GROUPS } from "./settingsConstants";

// The section components import the store / Tauri, so this test reads their source instead of rendering them:
// it ties every SETTINGS_INDEX entry to a row in the JSX and back.
const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string) => readFileSync(join(here, file), "utf8");

const SECTIONS: { id: SectionId; file: string; index: SettingMeta[] }[] = [
  { id: "general",    file: "GeneralSection.tsx",          index: GENERAL_INDEX },
  { id: "editor",     file: "EditorSettingsSection.tsx",   index: EDITOR_INDEX },
  { id: "terminal",   file: "TerminalSettingsSection.tsx", index: TERMINAL_INDEX },
  { id: "appearance", file: "AppearanceSection.tsx",       index: APPEARANCE_INDEX },
  { id: "shortcuts",  file: "ShortcutsSection.tsx",        index: SHORTCUTS_INDEX },
  { id: "updates",    file: "UpdatesSection.tsx",          index: UPDATES_INDEX },
  { id: "about",      file: "AboutSection.tsx",            index: ABOUT_INDEX },
];

/** Ids a section's JSX renders through `{...m("id")}` (row/block props taken from the index). */
const renderedIds = (src: string) => [...src.matchAll(/\{\.\.\.m\("([^"]+)"\)\}/g)].map((x) => x[1]);
const rowTags = (src: string) => (src.match(/<(SettingRow|SettingsBlock)\b/g) ?? []).length;

describe("settings section indexes", () => {
  it("ids are unique across the seven sections", () => {
    const all = SECTIONS.flatMap((s) => s.index.map((e) => e.id));
    expect(new Set(all).size).toBe(all.length);
  });

  for (const { id: section, file, index } of SECTIONS) {
    describe(section, () => {
      const src = source(file);

      it("is non-empty, exported as SETTINGS_INDEX, and every id starts with the section id", () => {
        expect(index.length).toBeGreaterThan(0);
        expect(src).toMatch(/export const SETTINGS_INDEX: SettingMeta\[\] = [A-Z_]+_INDEX;/);
        for (const e of index) {
          expect(e.section).toBe(section);
          expect(e.id.startsWith(`${section}.`)).toBe(true);
          expect(e.id.split(".").length).toBeGreaterThanOrEqual(3);
          expect(e.label.trim()).not.toBe("");
        }
      });

      if (section === "shortcuts") {
        it("renders one row per shortcut, with the same id and label as the index", () => {
          expect(src).toContain("id={shortcutId(s)}");
          expect(src).toContain("label={s.label}");
          expect(rowTags(src)).toBe(1); // the single mapped <SettingRow>
          const rendered = SHORTCUT_GROUPS.flatMap((g) => ALL_SHORTCUTS.filter((s) => s.section === g));
          expect(index.map((e) => e.id)).toEqual(rendered.map(shortcutId));
          expect(index.map((e) => e.label)).toEqual(rendered.map((s) => s.label));
        });
      } else {
        it("every index id is rendered exactly once, and nothing unindexed is rendered", () => {
          const ids = renderedIds(src);
          expect(new Set(ids).size).toBe(ids.length);
          expect([...ids].sort()).toEqual(index.map((e) => e.id).sort());
        });

        it("every row/block takes its id + label from the index (no hand-written label)", () => {
          expect(rowTags(src)).toBe(renderedIds(src).length);
          // Each <SettingRow>/<SettingsBlock> opens with the index spread…
          const opens = src.match(/<(SettingRow|SettingsBlock)\s+\{\.\.\.m\("/g) ?? [];
          expect(opens.length).toBe(rowTags(src));
          // …and never overrides the label afterwards.
          expect(src).not.toMatch(/<(SettingRow|SettingsBlock)\s+\{\.\.\.m\("[^"]+"\)\}[^>]*?\slabel=/);
          const m = indexProps(index);
          for (const e of index) expect(m(e.id).label).toBe(e.label);
        });
      }
    });
  }
});
