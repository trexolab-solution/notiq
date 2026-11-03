import { beforeEach, describe, expect, it, vi } from "vitest";

// Same browser stubs as openSettings.test.ts: the store touches localStorage / document at import time.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal("document", { documentElement: { style: { setProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} } } });
vi.mock("../lib/session", () => ({ saveSession: async () => {}, loadSession: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {} }));
vi.mock("../lib/vaultMemory", () => ({ scrubMonacoModels: async () => {} }));

const { useAppStore } = await import("./index");
const st = () => useAppStore.getState();
const entry = (name: string) => ({ path: `C:\\vault\\${name}.nqv`, title: name, content: "" });
const titles = () => st().tabs.map((t) => `${t.title}${t.isPreview ? "*" : ""}`);

beforeEach(() => {
  useAppStore.setState({ tabs: [], activeTabId: null });
});

describe("openVaultEntry (preview tab policy)", () => {
  it("a single click reuses one preview tab, in place, and focuses it", () => {
    st().addTab({ title: "Note" });
    st().openVaultEntry(entry("a"), "preview");
    st().openVaultEntry(entry("b"), "preview");
    expect(titles()).toEqual(["Note", "b*"]);
    expect(st().activeTabId).toBe(st().tabs[1].id);
    expect(st().tabs[1]).toMatchObject({ filePath: "C:/vault/b.nqv", vaultLocked: true, isDirty: false });
  });

  it("editing makes the preview tab permanent, so the next click opens a new preview tab (no edits lost)", () => {
    st().openVaultEntry(entry("a"), "preview");
    const id = st().tabs[0].id;
    st().updateTabContent(id, "edited");
    st().openVaultEntry(entry("b"), "preview");
    expect(titles()).toEqual(["a", "b*"]);
    expect(st().tabs[0]).toMatchObject({ content: "edited", isDirty: true });
  });

  it("Ctrl+click / middle-click open a permanent tab and leave the preview tab alone", () => {
    st().openVaultEntry(entry("a"), "preview");
    st().openVaultEntry(entry("b"), "permanent");
    expect(titles()).toEqual(["a*", "b"]);
  });

  it("an already open entry is just focused; opening it permanently (double-click) keeps it", () => {
    st().openVaultEntry(entry("a"), "preview");
    st().openVaultEntry(entry("b"), "permanent");
    st().openVaultEntry(entry("a"), "preview");
    expect(titles()).toEqual(["a*", "b"]);
    expect(st().activeTabId).toBe(st().tabs[0].id);
    st().openVaultEntry(entry("a"), "permanent");
    expect(titles()).toEqual(["a", "b"]);
  });

  it("makeTabPermanent (double-click on the tab title) and pinning both end the preview", () => {
    st().openVaultEntry(entry("a"), "preview");
    st().makeTabPermanent(st().tabs[0].id);
    st().openVaultEntry(entry("b"), "preview");
    st().togglePinTab(st().tabs[1].id);
    expect(titles()).toEqual(["b", "a"]); // pinned tabs sort first
    expect(st().tabs.every((t) => !t.isPreview)).toBe(true);
  });
});
