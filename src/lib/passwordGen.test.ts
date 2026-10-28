import { describe, expect, it } from "vitest";
import { DEFAULT_PW_OPTIONS, generateWithOptions, sanitizePwOptions } from "./passwordGen";

describe("generateWithOptions", () => {
  it("honours length and has one of every enabled class", () => {
    for (let i = 0; i < 50; i++) {
      const p = generateWithOptions({ ...DEFAULT_PW_OPTIONS, length: 12 });
      expect(p).toHaveLength(12);
      expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[0-9]/); expect(p).toMatch(/[^a-zA-Z0-9]/);
    }
  });

  it("only uses enabled classes", () => {
    expect(generateWithOptions({ ...DEFAULT_PW_OPTIONS, upper: false, symbols: false, digits: false })).toMatch(/^[a-z]+$/);
    expect(generateWithOptions({ ...DEFAULT_PW_OPTIONS, lower: false, upper: false, symbols: false })).toMatch(/^[0-9]+$/);
  });

  it("avoids look-alike characters unless told otherwise", () => {
    for (let i = 0; i < 100; i++) {
      expect(generateWithOptions({ ...DEFAULT_PW_OPTIONS, length: 64 })).not.toMatch(/[lIO01]/);
    }
    const any = Array.from({ length: 300 }, () => generateWithOptions({ ...DEFAULT_PW_OPTIONS, length: 64, avoidAmbiguous: false })).join("");
    expect(any).toMatch(/[lIO01]/);
  });

  it("generates different passwords", () => {
    expect(generateWithOptions({})).not.toBe(generateWithOptions({}));
  });
});

describe("sanitizePwOptions", () => {
  it("clamps length and never turns every class off", () => {
    expect(sanitizePwOptions({ length: 2 }).length).toBe(8);
    expect(sanitizePwOptions({ length: 500 }).length).toBe(64);
    expect(sanitizePwOptions({ length: NaN }).length).toBe(DEFAULT_PW_OPTIONS.length);
    const o = sanitizePwOptions({ lower: false, upper: false, digits: false, symbols: false });
    expect(o.lower).toBe(true);
  });
  it("falls back to defaults for junk", () => {
    expect(sanitizePwOptions(null)).toEqual(DEFAULT_PW_OPTIONS);
  });
});
