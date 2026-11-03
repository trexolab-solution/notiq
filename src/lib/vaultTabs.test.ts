import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import { isReusablePreview, openModeFromEvent, planVaultOpen } from "./vaultTabs";

const tab = (id: string, o: Partial<Tab> = {}): Tab => ({
  id, kind: "note", title: id, content: "", isDirty: false, cursorPosition: { line: 1, column: 1 },
  scrollPosition: 0, editorMode: "split", createdAt: 0, updatedAt: 0, isPinned: false, ...o,
});
const A = "C:/vault/a.nqv", B = "C:/vault/b.nqv";

describe("planVaultOpen", () => {
  it("focuses an entry that is already open (path compared case- and slash-insensitively)", () => {
    const tabs = [tab("1", { filePath: A })];
    expect(planVaultOpen(tabs, "c:\\VAULT\\a.nqv", "preview")).toEqual({ action: "focus", tabId: "1", promote: false });
  });

  it("promotes an open preview tab when opened permanently (double-click / Ctrl+click)", () => {
    const tabs = [tab("1", { filePath: A, isPreview: true })];
    expect(planVaultOpen(tabs, A, "permanent")).toEqual({ action: "focus", tabId: "1", promote: true });
    expect(planVaultOpen(tabs, A, "preview")).toEqual({ action: "focus", tabId: "1", promote: false });
  });

  it("replaces the clean preview tab on a single click", () => {
    const tabs = [tab("n", { filePath: "C:/notes/x.md" }), tab("p", { filePath: A, isPreview: true })];
    expect(planVaultOpen(tabs, B, "preview")).toEqual({ action: "replace", tabId: "p" });
  });

  it("never replaces a dirty or pinned preview tab — a new preview tab opens instead", () => {
    expect(planVaultOpen([tab("p", { filePath: A, isPreview: true, isDirty: true })], B, "preview"))
      .toEqual({ action: "new", preview: true });
    expect(planVaultOpen([tab("p", { filePath: A, isPreview: true, isPinned: true })], B, "preview"))
      .toEqual({ action: "new", preview: true });
  });

  it("opens a new preview tab when there is no preview tab, and never reuses permanent tabs", () => {
    expect(planVaultOpen([], A, "preview")).toEqual({ action: "new", preview: true });
    expect(planVaultOpen([tab("1", { filePath: A })], B, "preview")).toEqual({ action: "new", preview: true });
  });

  it("Ctrl+click opens a new permanent tab even when a preview tab could be reused", () => {
    expect(planVaultOpen([tab("p", { filePath: A, isPreview: true })], B, "permanent"))
      .toEqual({ action: "new", preview: false });
  });
});

describe("isReusablePreview", () => {
  it("only matches clean, unpinned vault note preview tabs", () => {
    expect(isReusablePreview(tab("p", { filePath: A, isPreview: true }))).toBe(true);
    expect(isReusablePreview(tab("p", { filePath: A }))).toBe(false);
    expect(isReusablePreview(tab("p", { filePath: "C:/x.md", isPreview: true }))).toBe(false);
    expect(isReusablePreview(tab("p", { filePath: A, isPreview: true, isDirty: true }))).toBe(false);
  });
});

describe("openModeFromEvent", () => {
  it("Ctrl, Cmd and middle-click open permanently; a plain click previews", () => {
    expect(openModeFromEvent({ button: 0 })).toBe("preview");
    expect(openModeFromEvent({ ctrlKey: true, button: 0 })).toBe("permanent");
    expect(openModeFromEvent({ metaKey: true })).toBe("permanent");
    expect(openModeFromEvent({ button: 1 })).toBe("permanent");
  });
});
