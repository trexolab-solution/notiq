import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { closeDecision, dirtyVaultTabs, unsavedCloseText } from "./closeGuard";
import type { Tab } from "../types";

const tab = (o: Partial<Tab> = {}): Tab => ({
  id: "t", kind: "note", title: "T", content: "", isDirty: false, isPinned: false, ...o,
} as Tab);
const noDrawing = () => false;

describe("closeDecision", () => {
  it("never closes a pinned tab", () => {
    expect(closeDecision(tab({ isPinned: true, isDirty: true }), noDrawing)).toBe("blocked");
  });
  it("closes clean tabs and Settings straight away", () => {
    expect(closeDecision(tab({ filePath: "C:/n.md" }), noDrawing)).toBe("close");
    expect(closeDecision(tab({ kind: "settings", isDirty: true }), noDrawing)).toBe("close");
  });
  it("asks for a dirty note, or unsaved content with no file", () => {
    expect(closeDecision(tab({ filePath: "C:/n.md", isDirty: true }), noDrawing)).toBe("confirm");
    expect(closeDecision(tab({ content: "hello" }), noDrawing)).toBe("confirm");
  });
  it("asks for a vault entry with unsaved changes, not for a saved one", () => {
    const entry = { filePath: "C:/V/Logins/GitHub.nqv", vaultExt: "login", content: "{}" };
    expect(closeDecision(tab({ ...entry, isDirty: true }), noDrawing)).toBe("confirm");
    expect(closeDecision(tab(entry), noDrawing)).toBe("close");
  });
  it("closes a locked vault tab (it holds no plaintext)", () => {
    expect(closeDecision(tab({ filePath: "C:/V/a.nqv", vaultLocked: true }), noDrawing)).toBe("close");
  });
  it("closes a generated page like What's New without asking, unless someone edited it", () => {
    expect(closeDecision(tab({ transient: true, content: "# What's New" }), noDrawing)).toBe("close");
    expect(closeDecision(tab({ transient: true, content: "# What's New", isDirty: true }), noDrawing)).toBe("confirm");
  });
  it("asks for a whiteboard only when it has drawings", () => {
    expect(closeDecision(tab({ kind: "whiteboard" }), () => true)).toBe("confirm");
    expect(closeDecision(tab({ kind: "whiteboard" }), noDrawing)).toBe("close");
  });
});

describe("unsavedCloseText", () => {
  it("talks about a vault entry, not a note", () => {
    const t = unsavedCloseText({ filePath: "C:/V/a.nqv", vaultExt: "ssh" });
    expect(t.message).toMatch(/vault entry/);
    expect(t.message).not.toMatch(/note/);
    expect(t.confirmLabel).toBe("Save");
  });
  it("keeps the note wording for notes", () => {
    expect(unsavedCloseText({ filePath: "C:/V/a.nqv", vaultExt: "md" }).message).toMatch(/vault note/);
    expect(unsavedCloseText({ filePath: "C:/n.md" }).message).toMatch(/This note has unsaved/);
    expect(unsavedCloseText({}).confirmLabel).toBe("Save As");
  });
});

describe("dirtyVaultTabs", () => {
  it("lists unlocked, dirty vault tabs only", () => {
    const tabs = [
      tab({ id: "a", filePath: "C:/V/a.nqv", isDirty: true }),
      tab({ id: "b", filePath: "C:/V/b.nqv" }),
      tab({ id: "c", filePath: "C:/n.md", isDirty: true }),
      tab({ id: "d", filePath: "C:/V/d.nqv", isDirty: true, vaultLocked: true }),
    ];
    expect(dirtyVaultTabs(tabs).map((t) => t.id)).toEqual(["a"]);
  });
});
