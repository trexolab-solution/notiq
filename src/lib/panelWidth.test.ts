import { afterEach, describe, expect, it, vi } from "vitest";
import { panelWidth } from "./panelWidth";

const spec = { key: "pw:test", min: 200, def: 300, step: 10, maxFor: (a: number) => a * 0.5 };

function stubStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
  });
  return data;
}
afterEach(() => vi.unstubAllGlobals());

describe("panelWidth", () => {
  it("max never drops below min and tolerates non-finite space", () => {
    const p = panelWidth(spec);
    expect(p.max(1000)).toBe(500);
    expect(p.max(100)).toBe(200);
    expect(p.max(NaN)).toBe(200);
  });
  it("clamp rounds, bounds, and falls back to default for NaN", () => {
    const p = panelWidth(spec);
    expect(p.clamp(50, 1000)).toBe(200);
    expect(p.clamp(9999, 1000)).toBe(500);
    expect(p.clamp(333.6, 1000)).toBe(334);
    expect(p.clamp(NaN, 1000)).toBe(300);
    expect(p.clamp(NaN, 400)).toBe(200);
  });
  it("load returns default when unset/invalid and applies min to stored values", () => {
    const p = panelWidth(spec);
    stubStorage();
    expect(p.load()).toBe(300);
    stubStorage({ "pw:test": "abc" });
    expect(p.load()).toBe(300);
    stubStorage({ "pw:test": "120" });
    expect(p.load()).toBe(200);
    stubStorage({ "pw:test": "444.4" });
    expect(p.load()).toBe(444);
  });
  it("save persists a rounded value; storage failures are swallowed", () => {
    const p = panelWidth(spec);
    const data = stubStorage();
    p.save(250.7);
    expect(data["pw:test"]).toBe("251");
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } });
    expect(() => p.save(1)).not.toThrow();
    expect(p.load()).toBe(300);
  });
});
