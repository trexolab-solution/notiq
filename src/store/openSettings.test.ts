import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "../types";

// The store module touches localStorage / document at import time and persists through IndexedDB:
// stub the browser bits and capture what would be saved.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
});
vi.stubGlobal("document", { documentElement: { style: { setProperty() {} }, setAttribute() {}, classList: { add() {}, remove() {}, toggle() {} } } });

const saved: SessionData[] = [];
vi.mock("../lib/session", () => ({
  saveSession: async (d: SessionData) => { saved.push(structuredClone(d)); },
  loadSession: async () => null,
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: async () => {} }));

const { useAppStore } = await import("./index");
const st = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ tabs: [], activeTabId: null, settingsTarget: null, activeView: "editor" });
  saved.length = 0;
});

describe("openSettings", () => {
  it("creates a single Settings tab and activates it", () => {
    st().addTab({ title: "Note" });
    st().openSettings();
    const settings = st().tabs.filter((t) => t.kind === "settings");
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({ title: "Settings", content: "", isDirty: false });
    expect(settings[0].filePath).toBeUndefined();
    expect(st().activeTabId).toBe(settings[0].id);
    expect(st().settingsTarget).toBeNull(); // no section → no deep link
  });

  it("is a singleton: a second call re-activates the existing tab and switches back to the editor view", () => {
    st().openSettings();
    const id = st().activeTabId;
    st().addTab({ title: "Other" });
    st().setActiveView("graph");
    st().openSettings();
    expect(st().tabs.filter((t) => t.kind === "settings")).toHaveLength(1);
    expect(st().activeTabId).toBe(id);
    expect(st().activeView).toBe("editor");
  });

  it("records a deep-link target with a fresh nonce on every request", () => {
    st().openSettings("vault");
    const a = st().settingsTarget!;
    expect(a).toMatchObject({ section: "vault", settingId: undefined });
    st().openSettings("ai", "ai.provider.model");
    const b = st().settingsTarget!;
    expect(b).toMatchObject({ section: "ai", settingId: "ai.provider.model" });
    expect(b.nonce).toBeGreaterThan(a.nonce);
    st().openSettings("ai", "ai.provider.model"); // same place again still re-triggers
    expect(st().settingsTarget!.nonce).toBeGreaterThan(b.nonce);
    st().openSettings(); // plain open keeps the last target (nothing new to reveal)
    expect(st().settingsTarget!.nonce).toBe(b.nonce + 1);
  });

  it("closing the Settings tab clears the target; reopening creates a new tab", () => {
    st().openSettings("general");
    const id = st().activeTabId!;
    st().removeTab(id);
    expect(st().settingsTarget).toBeNull();
    expect(st().tabs.some((t) => t.kind === "settings")).toBe(false);
    st().openSettings();
    expect(st().tabs.filter((t) => t.kind === "settings")).toHaveLength(1);
  });

  it("the Settings tab can't be renamed, edited or saved", async () => {
    st().openSettings();
    const id = st().activeTabId!;
    st().updateTabTitle(id, "Hacked");
    st().updateTabContent(id, "text");
    const t = st().tabs.find((x) => x.id === id)!;
    expect(t.title).toBe("Settings");
    expect(t.content).toBe("");
    expect(t.isDirty).toBe(false);
    await expect(st().saveTabToFile(id)).resolves.toBe(false);
  });

  it("is excluded from the knowledge graph", () => {
    st().addTab({ title: "Note" });
    st().openSettings();
    st().rebuildGraph();
    expect(st().graphData.nodes.map((n) => n.name)).toEqual(["Note"]);
  });
});

describe("Settings tab persistence", () => {
  it("round-trips through the saved session and restores as the active tab", () => {
    st().addTab({ title: "Note" });
    st().openSettings();
    const id = st().activeTabId;
    const session = saved[saved.length - 1];
    expect(session.tabs.map((t) => t.kind)).toEqual(["note", "settings"]);
    expect(session.activeTabId).toBe(id);

    useAppStore.setState({ tabs: [], activeTabId: null });
    st().hydrate(session.tabs, session.activeTabId, session.themeId);
    expect(st().tabs.map((t) => t.kind)).toEqual(["note", "settings"]);
    expect(st().activeTabId).toBe(id);
    // Restored → openSettings re-uses it.
    st().openSettings("about");
    expect(st().tabs.filter((t) => t.kind === "settings")).toHaveLength(1);
    expect(st().activeTabId).toBe(id);
  });

  it("drops duplicate Settings tabs from an old/corrupt session, keeping the active one valid", () => {
    const base = { content: "", isDirty: false, cursorPosition: { line: 1, column: 1 }, scrollPosition: 0, editorMode: "preview" as const, createdAt: 0, updatedAt: 0, isPinned: false };
    st().hydrate([
      { ...base, id: "s1", kind: "settings", title: "Settings" },
      { ...base, id: "n", kind: "note", title: "N" },
      { ...base, id: "s2", kind: "settings", title: "Settings" },
    ], "s2", "dark");
    expect(st().tabs.map((t) => t.id)).toEqual(["s1", "n"]);
    expect(st().activeTabId).toBe("s1");
  });
});
