import { describe, expect, it } from "vitest";
import { matchesQuery, queryTokens } from "./settingsFilter";

describe("matchesQuery", () => {
  const row = { label: "Auto-lock after inactivity", description: "Locks the vault when idle", keywords: ["timeout"], section: "Vault" };

  it("matches everything for an empty query", () => {
    expect(matchesQuery("", row)).toBe(true);
    expect(matchesQuery("   ", row)).toBe(true);
  });

  it("needs every word, in any order, case-insensitively", () => {
    expect(matchesQuery("lock vault", row)).toBe(true);
    expect(matchesQuery("VAULT LOCK", row)).toBe(true);
    expect(matchesQuery("lock terminal", row)).toBe(false);
  });

  it("searches keywords, section and description", () => {
    expect(matchesQuery("timeout", row)).toBe(true);
    expect(matchesQuery("vault", { label: "x", section: "Vault" })).toBe(true);
    expect(matchesQuery("idle", row)).toBe(true);
  });

  it("ignores accents", () => {
    expect(matchesQuery("cafe", { label: "Café mode" })).toBe(true);
  });

  it("splits the query into words", () => {
    expect(queryTokens("  a  b ")).toEqual(["a", "b"]);
  });
});
