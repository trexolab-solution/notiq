import { describe, expect, it } from "vitest";
import { buildContractTheme, readableOn, toHex } from "./autofillTheme";

describe("toHex", () => {
  it("converts the supported formats", () => {
    expect(toHex("#ABC")).toBe("#aabbcc");
    expect(toHex(" #0F172A ")).toBe("#0f172a");
    expect(toHex("rgb(15, 23, 42)")).toBe("#0f172a");
    expect(toHex("rgba(255 0 128 / 0.5)")).toBe("#ff0080");
    expect(toHex("color(srgb 1 0.5 0)")).toBe("#ff8000");
  });
  it("rejects junk", () => {
    expect(toHex("")).toBeNull();
    expect(toHex("var(--x)")).toBeNull();
    expect(toHex(undefined)).toBeNull();
  });
});

describe("readableOn", () => {
  it("picks dark text on light colours and white on dark", () => {
    expect(readableOn("#facc15")).toBe("#0f172a");
    expect(readableOn("#1e293b")).toBe("#ffffff");
    expect(readableOn("#b45309")).toBe("#ffffff");
  });
});

describe("buildContractTheme", () => {
  it("uses computed values and derives mode/primaryText", () => {
    const vars: Record<string, string> = { "--color-bg": "rgb(248, 250, 252)", "--color-primary": "#facc15" };
    const t = buildContractTheme("light", (n) => vars[n] ?? "");
    expect(t.mode).toBe("light");
    expect(t.bg).toBe("#f8fafc");
    expect(t.primary).toBe("#facc15");
    expect(t.primaryText).toBe("#0f172a");
    for (const v of [t.bgSecondary, t.text, t.border, t.danger, t.success]) expect(v).toMatch(/^#[0-9a-f]{6}$/);
  });
  it("falls back to the theme table and sanitises the id", () => {
    const t = buildContractTheme("dark", () => "");
    expect(t.mode).toBe("dark");
    expect(t.bg).toBe("#0f172a");
    expect(buildContractTheme("bad id!", () => "").id).toBe("dark");
  });
});
