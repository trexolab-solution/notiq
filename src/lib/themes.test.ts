import { describe, it, expect } from "vitest";
import { THEMES } from "./themes";

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
