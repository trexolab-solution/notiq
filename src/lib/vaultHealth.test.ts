import { describe, expect, it } from "vitest";
import { analyzeHealth, estimateStrength, isWeak, itemsWithIssue, type HealthInput } from "./vaultHealth";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 29);

const inp = (rel: string, password: string, extra: Partial<HealthInput["entry"]> = {}, ageDays = 1): HealthInput => ({
  rel, path: `/root/${rel}`, updated: NOW - ageDays * DAY,
  entry: { title: rel.replace(/\.nqv$/, ""), url: "https://example.com", urls: [], username: "me", password, ...extra },
});

describe("estimateStrength / isWeak", () => {
  it("flags short, common, and pattern passwords", () => {
    for (const pw of ["short1!", "password123", "Password1!", "P@ssw0rd", "Summer2024!", "qwertyuiop", "1234567890",
      "aaaaaaaaaaaa", "abcabcabcabc", "asdfghjkl;'", "iloveyou12"]) {
      expect(isWeak(pw), pw).toBe(true);
    }
  });
  it("accepts long random-looking passwords", () => {
    for (const pw of ["k7#Vq2!mZp9xR4", "correct horse battery staple", "u8Gd-Wq3s-Lm9z-Xe2r"]) {
      expect(isWeak(pw), pw).toBe(false);
    }
  });
  it("scores grow with length and variety", () => {
    expect(estimateStrength("").score).toBe(0);
    expect(estimateStrength("aaaaaaaaaaaa").score).toBeLessThan(estimateStrength("k7#Vq2!mZp9xR4").score);
    expect(estimateStrength("k7#Vq2!mZp9xR4cT8&").score).toBe(4);
    expect(isWeak("")).toBe(false); // empty is its own issue
  });
});

describe("analyzeHealth", () => {
  it("reports weak, reused, old, empty and http issues without passwords", async () => {
    const strong = "k7#Vq2!mZp9xR4cT8&";
    const r = await analyzeHealth([
      inp("a.nqv", strong),
      inp("b.nqv", strong, { url: "http://intranet.example.com" }),
      inp("c.nqv", "password1"),
      inp("d.nqv", ""),
      inp("e.nqv", "u8Gd-Wq3s-Lm9z-Xe2r", {}, 400),
      inp("f.nqv", "Zx9!pL2#qW7$rT5", { url: "", urls: ["http://legacy.example.org"] }),
    ], NOW);
    expect(r.total).toBe(6);
    expect(r.counts).toEqual({ weak: 1, reused: 2, old: 1, empty: 1, http: 2 });
    expect(r.reusedGroups).toEqual([["a.nqv", "b.nqv"]]);
    const by = Object.fromEntries(r.items.map((i) => [i.rel, i]));
    expect(by["a.nqv"].reusedWith).toBe(1);
    expect(by["c.nqv"].issues).toEqual(["weak"]);
    expect(by["d.nqv"].issues).toEqual(["empty"]);
    expect(by["d.nqv"].strength).toBeNull();
    expect(by["e.nqv"].issues).toEqual(["old"]);
    expect(by["e.nqv"].ageDays).toBe(400);
    expect(by["f.nqv"].host).toBe("legacy.example.org");
    expect(r.score).toBeGreaterThan(0);
    expect(r.score).toBeLessThan(100);
    // No password text anywhere in the report.
    const json = JSON.stringify(r);
    for (const pw of [strong, "password1", "u8Gd-Wq3s-Lm9z-Xe2r"]) expect(json).not.toContain(pw);
  });
  it("gives a perfect score to an empty vault and to clean entries", async () => {
    expect((await analyzeHealth([], NOW)).score).toBe(100);
    expect((await analyzeHealth([inp("a.nqv", "k7#Vq2!mZp9xR4cT8&")], NOW)).score).toBe(100);
  });
  it("filters and orders items by issue", async () => {
    const r = await analyzeHealth([inp("ok.nqv", "k7#Vq2!mZp9xR4cT8&"), inp("w.nqv", "123456"), inp("e.nqv", "")], NOW);
    expect(itemsWithIssue(r, null).map((i) => i.rel).sort()).toEqual(["e.nqv", "w.nqv"]);
    expect(itemsWithIssue(r, "weak").map((i) => i.rel)).toEqual(["w.nqv"]);
  });
});
