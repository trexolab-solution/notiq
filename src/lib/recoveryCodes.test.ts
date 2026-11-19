import { describe, expect, it } from "vitest";
import {
  MAX_CODES, addCodes, emptyCodes, nextUnused, parseCodes, remainingCount, removeCode, serializeCodes, splitCodes, toggleUsed,
} from "./recoveryCodes";

describe("parseCodes / serializeCodes", () => {
  it("round-trips", () => {
    const e = { ...emptyCodes("T"), service: "S", notes: "N", codes: [{ code: "aaa", used: true }, { code: "bbb", used: false }] };
    expect(parseCodes(serializeCodes(e))).toEqual(e);
  });
  it("falls back to an empty entry on bad JSON", () => {
    expect(parseCodes("not json")).toEqual(emptyCodes());
  });
  it("accepts string lists, trims, drops blanks and non-string fields", () => {
    const e = parseCodes(JSON.stringify({ title: 5, codes: [" a ", "", "  ", { code: "b", used: true }, { code: 3 }, null] }));
    expect(e.title).toBe("");
    expect(e.codes).toEqual([{ code: "a", used: false }, { code: "b", used: true }]);
  });
  it("caps the number of codes", () => {
    const e = parseCodes(JSON.stringify({ codes: Array.from({ length: 200 }, (_, i) => `c${i}`) }));
    expect(e.codes).toHaveLength(MAX_CODES);
  });
});

describe("splitCodes / addCodes", () => {
  it("splits on whitespace, commas and semicolons", () => {
    expect(splitCodes("a b\nc,d;;e\t f")).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(splitCodes("   ")).toEqual([]);
  });
  it("skips duplicates case-insensitively, including within the pasted text", () => {
    const r = addCodes([{ code: "ABC", used: true }], "abc def DEF ghi");
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(2);
    expect(r.codes.map((c) => c.code)).toEqual(["ABC", "def", "ghi"]);
  });
  it("stops at MAX_CODES", () => {
    const list = Array.from({ length: MAX_CODES - 1 }, (_, i) => ({ code: `x${i}`, used: false }));
    const r = addCodes(list, "n1 n2 n3");
    expect(r.codes).toHaveLength(MAX_CODES);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(2);
  });
});

describe("list helpers", () => {
  const list = [{ code: "a", used: true }, { code: "b", used: false }, { code: "c", used: false }];
  it("toggleUsed is immutable", () => {
    const t = toggleUsed(list, 1);
    expect(t[1].used).toBe(true);
    expect(list[1].used).toBe(false);
  });
  it("removeCode, nextUnused, remainingCount", () => {
    expect(removeCode(list, 0).map((c) => c.code)).toEqual(["b", "c"]);
    expect(nextUnused(list)).toBe(1);
    expect(nextUnused([{ code: "a", used: true }])).toBe(-1);
    expect(remainingCount(list)).toBe(2);
  });
});
