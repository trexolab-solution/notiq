import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTree } from "./vaultTree";
import type { VaultItem } from "./vault";

const item = (rel: string): VaultItem => ({
  rel, ext: "login", updated: 1, dir: false, tags: [], starred: false, trashed_at: null, attachments: 0, history: 0,
} as VaultItem);

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});
const { recordUse, remapUsage, resetUsage } = await import("./vaultUsage");

describe("vault usage sorting", () => {
  beforeEach(() => { store.clear(); resetUsage(); });

  const snap = () => JSON.parse(localStorage.getItem("vault:usage")!);
  const ITEMS = [item("a.nqv"), item("b.nqv"), item("c.nqv")];
  const names = (usage: Parameters<typeof buildTree>[2], sort: "recent" | "used") =>
    buildTree(ITEMS, sort, usage).map((n) => n.name);

  it("puts the most recently used first, never-used ones after by name", () => {
    recordUse("c.nqv", 1000);
    recordUse("a.nqv", 2000);
    expect(names(snap(), "recent")).toEqual(["a", "c", "b"]);
  });

  it("puts the most used first", () => {
    recordUse("b.nqv", 1); recordUse("b.nqv", 2); recordUse("b.nqv", 3);
    recordUse("c.nqv", 4);
    expect(names(snap(), "used")).toEqual(["b", "c", "a"]);
  });

  it("keeps the history when an entry is renamed or moved", () => {
    recordUse("Work/a.nqv", 1);
    remapUsage("Work", "Job");
    const stored = snap();
    expect(Object.keys(stored)).toEqual(["job/a.nqv"]);
  });
});
