import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SettingMeta } from "../../../lib/settingsIndex";

// The sections import the zustand store, which reads localStorage at load time (node has none).
const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage ??= {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
const VAULT_INDEX: SettingMeta[] = (await import("./VaultSection")).SETTINGS_INDEX;
const AI_INDEX: SettingMeta[] = (await import("./AISettingsSection")).SETTINGS_INDEX;

const root = resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const VAULT_FILES = [
  "components/ui/settings/VaultSection.tsx",
  "components/ui/settings/VaultPrefRows.tsx",
  "components/ui/settings/SessionLockRow.tsx",
  "components/ui/settings/QuickSearchRow.tsx",
  "components/ui/settings/HelloRow.tsx",
  "components/ui/settings/AutofillSection.tsx",
  "components/vault/BackupSection.tsx",
];
const AI_FILES = [
  "components/ui/settings/AISettingsSection.tsx",
  "components/ui/settings/ProviderConfigCard.tsx",
];

/** Ids a set of source files actually render: `id="x"` props, plus `id: "x"` entries of ProviderConfigCard's map. */
function renderedIds(files: string[], prefix: string): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/\bid="([^"]+)"/g)) if (m[1].startsWith(prefix)) out.add(m[1]);
    if (f.endsWith("ProviderConfigCard.tsx")) {
      for (const m of src.matchAll(/\bid: "([^"]+)"/g)) if (m[1].startsWith(prefix)) out.add(m[1]);
    }
  }
  return [...out];
}

const cases = [
  { name: "vault", index: VAULT_INDEX, files: VAULT_FILES, prefix: "vault." },
  { name: "ai", index: AI_INDEX, files: AI_FILES, prefix: "ai." },
];

describe.each(cases)("$name settings index", ({ index, files, prefix, name }) => {
  const sources = files.map(read).join("\n");

  it("has unique, correctly prefixed ids and the right section", () => {
    const ids = index.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of index) {
      expect(m.id.startsWith(prefix)).toBe(true);
      expect(m.section).toBe(name);
      expect(m.label.length).toBeGreaterThan(0);
    }
  });

  it("lists exactly the ids the components render", () => {
    expect(index.map((m) => m.id).sort()).toEqual(renderedIds(files, prefix).sort());
  });

  it("uses the indexed label next to each rendered id", () => {
    for (const m of index) {
      const at = sources.indexOf(`"${m.id}"`);
      expect(at, `${m.id} not found in source`).toBeGreaterThanOrEqual(0);
      const near = sources.slice(at, at + 400);
      expect(near.includes(`"${m.label}"`), `label "${m.label}" not found after ${m.id}`).toBe(true);
    }
  });
});
