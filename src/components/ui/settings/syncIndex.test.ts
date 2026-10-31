import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rankSettings, visibleSections } from "../../../lib/settingsSearch";
import { matchesQuery } from "../../settings/settingsFilter";
import { SYNC_INDEX } from "./syncIndex";

const read = (f: string) => readFileSync(resolve(__dirname, f), "utf8");

describe("Settings search finds Vault → Sync", () => {
  it("every Sync setting lives in the vault section's Sync group", () => {
    for (const m of SYNC_INDEX) {
      expect(m.section).toBe("vault");
      expect(m.group).toBe("Sync");
      expect(m.id.startsWith("vault.sync.")).toBe(true);
    }
  });

  it.each([
    ["sync", "vault.sync.account"],
    ["google drive", "vault.sync.account"],
    ["sync now", "vault.sync.status"],
    ["devices", "vault.sync.devices"],
    ["device name", "vault.sync.device-name"],
    ["attachment limit", "vault.sync.limits"],
    ["revoke", "vault.sync.permissions"],
  ])("“%s” finds %s", (query, id) => {
    expect(rankSettings(SYNC_INDEX, query).map((m) => m.id)).toContain(id);
    expect(visibleSections(SYNC_INDEX, query).has("vault")).toBe(true);
  });

  it("rows match with the same words at runtime (index keywords + description are passed to each row)", () => {
    for (const m of SYNC_INDEX) {
      expect(matchesQuery("sync", { label: m.label, keywords: [...(m.keywords ?? []), m.description ?? ""] })).toBe(true);
    }
  });

  it("VaultSection includes the Sync group and its index", () => {
    const src = read("VaultSection.tsx");
    expect(src).toContain("<SyncSection />");
    expect(src).toContain("...SYNC_INDEX");
  });
});
