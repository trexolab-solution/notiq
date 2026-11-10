import { describe, expect, it } from "vitest";
import { fitWindowSize, PROMPT_LIMITS, sizeChanged } from "./fitWindowSize";
import { splitHost } from "./hostParts";

describe("fitWindowSize", () => {
  it("keeps the width fixed and follows the content height", () => {
    expect(fitWindowSize(300, 250)).toEqual({ width: PROMPT_LIMITS.width, height: 250 });
    expect(fitWindowSize(900, 250).width).toBe(420);
  });
  it("clamps the height", () => {
    expect(fitWindowSize(420, 40).height).toBe(160);
    expect(fitWindowSize(420, 2000).height).toBe(560);
    expect(fitWindowSize(420, 300, { width: 380, minHeight: 100, maxHeight: 200 })).toEqual({ width: 380, height: 200 });
  });
  it("rounds fractional layout heights up (no 1px scrollbar)", () => {
    expect(fitWindowSize(420, 250.2).height).toBe(251);
  });
  it("falls back to the minimum for garbage", () => {
    expect(fitWindowSize(420, Number.NaN).height).toBe(160);
    expect(fitWindowSize(420, -5).height).toBe(160);
    expect(fitWindowSize(420, Infinity).height).toBe(160);
  });
  it("ignores sub-pixel jitter", () => {
    expect(sizeChanged(null, { width: 420, height: 200 })).toBe(true);
    expect(sizeChanged({ width: 420, height: 200 }, { width: 420, height: 200.4 })).toBe(false);
    expect(sizeChanged({ width: 420, height: 200 }, { width: 420, height: 201 })).toBe(true);
  });
});

describe("splitHost", () => {
  it("separates subdomains from the registrable domain", () => {
    expect(splitHost("login.example.com")).toEqual({ prefix: "login.", site: "example.com" });
    expect(splitHost("a.b.example.co.uk")).toEqual({ prefix: "a.b.", site: "example.co.uk" });
    expect(splitHost("example.com.evil.io")).toEqual({ prefix: "example.com.", site: "evil.io" });
  });
  it("shows hosts without a registrable domain whole", () => {
    expect(splitHost("example.com")).toEqual({ prefix: "", site: "example.com" });
    expect(splitHost("127.0.0.1")).toEqual({ prefix: "", site: "127.0.0.1" });
    expect(splitHost("localhost")).toEqual({ prefix: "", site: "localhost" });
  });
});
