import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { THEMES, isLightTheme } from "./themes";
import type { Theme, ThemeId } from "../types";

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("themes onPrimary", () => {
  for (const t of Object.values(THEMES)) {
    it(`${t.id}: onPrimary has >=4.5 contrast on primary and primaryHover`, () => {
      expect(t.colors.onPrimary).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrast(t.colors.onPrimary, t.colors.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.colors.onPrimary, t.colors.primaryHover)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// Themes held to the full WCAG AA bar (some older palettes predate it).
const AA_THEMES: ThemeId[] = ["github-light", "paper", "catppuccin-latte", "everforest", "graphite"];

describe("themes WCAG AA", () => {
  for (const id of AA_THEMES) {
    const t = THEMES[id];
    const c = t.colors;

    it(`${id}: text and muted text are readable on every surface`, () => {
      for (const surface of [c.bg, c.bgSecondary, c.bgTertiary]) {
        expect(contrast(c.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(c.textMuted, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(c.editorText, c.editorBg)).toBeGreaterThanOrEqual(4.5);
    });

    it(`${id}: primary, accent and status colours are readable as text`, () => {
      for (const key of ["primary", "accent", "success", "warning", "danger"] as const) {
        for (const surface of [c.bg, c.bgSecondary]) {
          expect(contrast(c[key], surface), `${key} on ${surface}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${id}: terminal colours are visible`, () => {
      for (const [name, hex] of Object.entries(t.ansi)) {
        // ANSI "black" is meant to sit close to a dark background.
        if (t.mode === "dark" && (name === "black" || name === "brightBlack")) continue;
        expect(contrast(hex, c.editorBg), name).toBeGreaterThanOrEqual(t.mode === "light" ? 3.5 : 4.5);
      }
    });

    if (t.mode === "light") {
      it(`${id}: white button text is readable on danger`, () => {
        expect(contrast("#ffffff", c.danger)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const cssName = (key: string) => "--color-" + key.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());

describe("themes stay in sync", () => {
  const css = read("../styles/themes.css");
  const html = read("../../index.html");
  const all = Object.values(THEMES) as Theme[];

  it("every theme defines the same colour and terminal tokens", () => {
    for (const t of all) {
      expect(Object.keys(t.colors).sort(), t.id).toEqual(Object.keys(THEMES.dark.colors).sort());
      expect(Object.keys(t.ansi).sort(), t.id).toEqual(Object.keys(THEMES.dark.ansi).sort());
    }
  });

  it("themes.css matches the theme table", () => {
    for (const t of all) {
      const block = new RegExp(`\\[data-theme="${t.id}"\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1];
      expect(block, t.id).toBeDefined();
      for (const [key, value] of Object.entries(t.colors)) {
        const found = new RegExp(`${cssName(key)}:\\s*(#[0-9a-fA-F]{6});`).exec(block!)?.[1];
        expect(found?.toLowerCase(), `${t.id} ${key}`).toBe(value.toLowerCase());
      }
    }
  });

  it("mode matches the background, and index.html knows every theme", () => {
    const lightList = /var light = \[([^\]]*)\]/.exec(html)![1];
    for (const t of all) {
      expect(lum(t.colors.bg) > 0.4, t.id).toBe(t.mode === "light");
      expect(isLightTheme(t.id)).toBe(t.mode === "light");
      expect(lightList.includes(`'${t.id}'`), t.id).toBe(t.mode === "light");
      for (const [map, value] of [["bg", t.colors.bg], ["fg", t.colors.text]]) {
        const line = new RegExp(`var ${map} = \\{.*\\};`).exec(html)![0];
        const key = t.id.includes("-") ? `'${t.id}'` : t.id;
        expect(line.toLowerCase(), `${t.id} ${map}`).toContain(` ${key}: '${value.toLowerCase()}'`);
      }
    }
  });

  it("treats unknown ids as dark", () => {
    expect(isLightTheme("nope")).toBe(false);
  });
});
