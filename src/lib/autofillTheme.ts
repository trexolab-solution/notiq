import { invoke } from "@tauri-apps/api/core";
import { THEMES } from "./themes";
import type { ThemeId } from "../types";

/** The theme object shared with the browser extension (via `autofill-theme.json`). All values are strings. */
export interface ContractTheme {
  id: string;
  mode: "dark" | "light";
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primaryText: string;
  danger: string;
  success: string;
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number) => clamp(n).toString(16).padStart(2, "0");

/** `#rgb`, `#rrggbb`, `rgb()/rgba()` and `color(srgb r g b)` (what `color-mix` computes to) → `#rrggbb`, else null. */
export function toHex(value: string | null | undefined): string | null {
  const v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return "#" + [...m[1]].map((c) => c + c).join("");
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{8}$/.test(v)) return v.slice(0, 7);
  m = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/.exec(v);
  if (m) {
    const ch = (n: string, pct: string) => (pct ? (parseFloat(n) / 100) * 255 : parseFloat(n));
    return "#" + hex2(ch(m[1], m[2])) + hex2(ch(m[3], m[4])) + hex2(ch(m[5], m[6]));
  }
  m = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(v);
  if (m) return "#" + hex2(parseFloat(m[1]) * 255) + hex2(parseFloat(m[2]) * 255) + hex2(parseFloat(m[3]) * 255);
  return null;
}

function luminance(hex: string): number {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
}

/** Readable text colour on top of `bg`: white or slate-900, whichever contrasts more. */
export function readableOn(bg: string): "#ffffff" | "#0f172a" {
  const l = luminance(bg);
  const withWhite = 1.05 / (l + 0.05);
  const withDark = (l + 0.05) / (luminance("#0f172a") + 0.05);
  return withWhite >= withDark ? "#ffffff" : "#0f172a";
}

const TOKENS = {
  bg: ["--color-bg", "bg"],
  bgSecondary: ["--color-bg-secondary", "bgSecondary"],
  bgTertiary: ["--color-bg-tertiary", "bgTertiary"],
  text: ["--color-text", "text"],
  textMuted: ["--color-text-muted", "textMuted"],
  border: ["--color-border", "border"],
  primary: ["--color-primary", "primary"],
  danger: ["--color-danger", "danger"],
  success: ["--color-success", "success"],
} as const;

/** Builds the contract object from a CSS-variable reader; a missing/unparsable token falls back to the theme table. */
export function buildContractTheme(id: string, readVar: (name: string) => string): ContractTheme {
  const table = (THEMES as Record<string, (typeof THEMES)[ThemeId] | undefined>)[id] ?? THEMES.dark;
  const out: Record<string, string> = {};
  for (const [key, [cssVar, themeKey]] of Object.entries(TOKENS)) {
    const fallback = (table.colors as unknown as Record<string, string>)[themeKey];
    out[key] = toHex(readVar(cssVar)) ?? toHex(fallback) ?? "#000000";
  }
  const safeId = /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : "dark";
  return {
    id: safeId,
    mode: luminance(out.bg) < 0.4 ? "dark" : "light",
    ...(out as Omit<ContractTheme, "id" | "mode" | "primaryText">),
    primaryText: readableOn(out.primary),
  };
}

/** Reads the computed theme from the document (call after the theme attribute is applied). */
export function readContractTheme(id: string): ContractTheme {
  const cs = getComputedStyle(document.documentElement);
  return buildContractTheme(id, (n) => cs.getPropertyValue(n));
}

/** Main window only. Errors (non-Tauri / test env) are swallowed. */
export function publishAutofillTheme(id: string): void {
  try {
    void Promise.resolve(invoke("autofill_set_theme", { theme: readContractTheme(id) })).catch(() => {});
  } catch {
    /* not running inside Tauri */
  }
}
