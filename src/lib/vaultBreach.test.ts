import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { analyzeHealth, applyBreaches, itemsWithIssue, type HealthInput } from "./vaultHealth";
import { BreachCheckError, checkBreaches, clearBreachCache } from "./vaultBreach";

const NOW = Date.UTC(2026, 9, 29);
const inp = (rel: string, password: string): HealthInput => ({
  rel, path: `/root/${rel}`, updated: NOW - 86_400_000,
  entry: { title: rel, url: "https://example.com", urls: [], username: "me", password },
});

// SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
const PW_PREFIX = "5BAA6";
const PW_SUFFIX = "1E4C9B93F3F0682250B6CF8331B7EE68FD8";
const STRONG = "k7#Vq2!mZp9xR4cT8&";

beforeEach(() => { invoke.mockReset(); clearBreachCache(); });

describe("checkBreaches", () => {
  it("sends only deduped 5-char prefixes and maps hits back to entries", async () => {
    invoke.mockResolvedValue([{ prefix: PW_PREFIX, hits: [{ suffix: PW_SUFFIX, count: 9545824 }] }]);
    const found = await checkBreaches([inp("a.nqv", "password"), inp("b.nqv", "password"), inp("c.nqv", ""), inp("d.nqv", STRONG)]);
    expect(found.get("a.nqv")).toBe(9545824);
    expect(found.get("b.nqv")).toBe(9545824);
    expect(found.has("c.nqv")).toBe(false);
    expect(found.has("d.nqv")).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invoke.mock.calls[0] as [string, { prefixes: string[] }];
    expect(cmd).toBe("breach_check_ranges");
    expect(args.prefixes).toHaveLength(2); // "password" and STRONG: two distinct prefixes
    expect(args.prefixes.every((p) => /^[0-9A-F]{5}$/.test(p))).toBe(true);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain(PW_SUFFIX);
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("password");
  });

  it("caches prefixes for the session", async () => {
    invoke.mockResolvedValue([{ prefix: PW_PREFIX, hits: [] }]);
    await checkBreaches([inp("a.nqv", "password")]);
    await checkBreaches([inp("a.nqv", "password")]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reports offline as a clear error", async () => {
    invoke.mockRejectedValue("offline");
    const err = await checkBreaches([inp("a.nqv", "password")]).catch((e) => e);
    expect(err).toBeInstanceOf(BreachCheckError);
    expect(err.message).toBe("Couldn't check: offline");
    // A failure is not cached as "clean".
    invoke.mockResolvedValue([{ prefix: PW_PREFIX, hits: [{ suffix: PW_SUFFIX, count: 3 }] }]);
    expect((await checkBreaches([inp("a.nqv", "password")])).get("a.nqv")).toBe(3);
  });
});

describe("applyBreaches", () => {
  it("adds the breached issue, lowers the score and ranks it first", async () => {
    const base = await analyzeHealth([inp("a.nqv", STRONG), inp("b.nqv", "Zx9!pL2#qW7$rT5")], NOW);
    const merged = applyBreaches(base, new Map([["b.nqv", 12]]));
    expect(merged.counts.breached).toBe(1);
    const b = merged.items.find((i) => i.rel === "b.nqv")!;
    expect(b.issues[0]).toBe("breached");
    expect(b.breachedCount).toBe(12);
    expect(merged.score).toBeLessThan(base.score);
    expect(itemsWithIssue(merged, "breached").map((i) => i.rel)).toEqual(["b.nqv"]);
    expect(JSON.stringify(merged)).not.toContain(STRONG);
  });

  it("is idempotent and removes breach data when given null", async () => {
    const base = await analyzeHealth([inp("a.nqv", STRONG)], NOW);
    const once = applyBreaches(base, new Map([["a.nqv", 1]]));
    const twice = applyBreaches(once, new Map([["a.nqv", 1]]));
    expect(twice.counts.breached).toBe(1);
    expect(twice.items[0].issues).toEqual(["breached"]);
    const cleared = applyBreaches(twice, null);
    expect(cleared.counts.breached).toBe(0);
    expect(cleared.score).toBe(base.score);
    expect(cleared.items[0].issues).toEqual([]);
  });
});
