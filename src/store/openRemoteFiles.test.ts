import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "../types";

// Same stubs as openSettings.test.ts: the store touches localStorage / document and saves through IndexedDB.
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

const web = { path: "C:/v/web.nqv", auth: "key" as const, title: "web" };

beforeEach(() => {
  useAppStore.setState({ tabs: [], activeTabId: null, activeView: "graph" });
  saved.length = 0;
});

describe("openRemoteFiles", () => {
  it("opens a files tab for the server and shows it", () => {
    st().addTab({ title: "Note" });
    st().openRemoteFiles(web);
    const files = st().tabs.filter((t) => t.kind === "files");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ title: "Files · web", remote: { path: web.path, auth: "key" }, content: "", isDirty: false });
    expect(files[0].filePath).toBeUndefined();
    expect(st().activeTabId).toBe(files[0].id);
    expect(st().activeView).toBe("editor");
  });

  it("focuses the tab it already has for that server and sign-in, but opens another for a different one", () => {
    st().openRemoteFiles(web);
    const first = st().activeTabId;
    st().addTab({ title: "Note" });
    st().openRemoteFiles(web);
    expect(st().tabs.filter((t) => t.kind === "files")).toHaveLength(1);
    expect(st().activeTabId).toBe(first);
    st().openRemoteFiles({ ...web, auth: "password" });
    st().openRemoteFiles({ ...web, path: "C:/v/db.nqv", title: "db" });
    expect(st().tabs.filter((t) => t.kind === "files")).toHaveLength(3);
  });

  it("is never saved to the session, and never the saved active tab", async () => {
    st().addTab({ title: "Note" });
    const note = st().activeTabId;
    st().openRemoteFiles(web);
    await Promise.resolve();
    const last = saved[saved.length - 1];
    expect(last.tabs.some((t) => t.kind === "files")).toBe(false);
    expect(last.activeTabId).toBe(note);
  });

  it("can't be renamed, edited or saved", async () => {
    st().openRemoteFiles(web);
    const id = st().activeTabId!;
    st().updateTabTitle(id, "Hacked");
    st().updateTabContent(id, "text");
    expect(st().tabs.find((t) => t.id === id)).toMatchObject({ title: "Files · web", content: "", isDirty: false });
    expect(await st().saveTabToFile(id)).toBe(false);
  });

  it("is dropped when an old session is restored", () => {
    st().hydrate([
      { id: "n", kind: "note", title: "N", content: "x", isDirty: false, cursorPosition: { line: 1, column: 1 }, scrollPosition: 0, editorMode: "split", createdAt: 0, updatedAt: 0, isPinned: false },
      { id: "f", kind: "files", title: "Files · web", content: "", isDirty: false, cursorPosition: { line: 1, column: 1 }, scrollPosition: 0, editorMode: "preview", createdAt: 0, updatedAt: 0, isPinned: false },
    ], "f", "dark");
    expect(st().tabs.map((t) => t.id)).toEqual(["n"]);
  });
});
