import { describe, expect, it } from "vitest";
import type { ContextMenuItem } from "../../components/ui/ContextMenu";
import {
  buildEditItems, buildEditorMenu, buildPreviewMenu, buildTabMenu, buildTabStripMenu,
  buildTerminalMenu, buildVaultLockedMenu, joinGroups,
} from "./items";

const noop = () => {};
const labels = (items: ContextMenuItem[]) => items.map((i) => (i.type === "separator" ? "---" : i.label));
const find = (items: ContextMenuItem[], label: string) => items.find((i) => i.label === label);
const allEdit = { cut: noop, copy: noop, paste: noop, undo: noop, redo: noop, selectAll: noop };

describe("joinGroups", () => {
  it("separates non-empty groups only", () => {
    const a: ContextMenuItem = { type: "item", label: "A" };
    expect(labels(joinGroups([a], [], [a]))).toEqual(["A", "---", "A"]);
    expect(joinGroups([], [])).toEqual([]);
  });
});

describe("buildEditItems", () => {
  it("disables Cut / Copy without a selection", () => {
    const m = buildEditItems({ hasSelection: false }, allEdit);
    expect(labels(m)).toEqual(["Cut", "Copy", "Paste", "---", "Undo", "Redo", "---", "Select All"]);
    expect(find(m, "Cut")?.disabled).toBe(true);
    expect(find(m, "Copy")?.disabled).toBe(true);
    expect(find(m, "Paste")?.disabled).toBe(false);
  });

  it("read-only: no Undo/Redo, Cut and Paste disabled, Copy still works", () => {
    const m = buildEditItems({ hasSelection: true, readOnly: true }, allEdit);
    expect(labels(m)).not.toContain("Undo");
    expect(find(m, "Cut")?.disabled).toBe(true);
    expect(find(m, "Paste")?.disabled).toBe(true);
    expect(find(m, "Copy")?.disabled).toBe(false);
  });

  it("never copies a password field", () => {
    const m = buildEditItems({ hasSelection: true, secret: true }, allEdit);
    expect(find(m, "Cut")?.disabled).toBe(true);
    expect(find(m, "Copy")?.disabled).toBe(true);
    expect(find(m, "Paste")?.disabled).toBe(false);
  });

  it("leaves out actions that weren't passed (e.g. Paste without clipboard access)", () => {
    const m = buildEditItems({ hasSelection: true }, { copy: noop, selectAll: noop });
    expect(labels(m)).toEqual(["Copy", "---", "Select All"]);
  });

  it("disables Select All on empty text", () => {
    expect(find(buildEditItems({ hasSelection: false, isEmpty: true }, allEdit), "Select All")?.disabled).toBe(true);
  });
});

describe("buildEditorMenu", () => {
  const actions = {
    ...allEdit, find: noop, replace: noop, format: noop,
    aiContinue: noop, aiFixGrammar: noop, aiSummarize: noop, aiGenerateTitle: noop, aiFixMermaid: noop,
  };
  const base = { hasSelection: false, aiEnabled: true, isMarkdownNote: false, inMermaid: false };

  it("offers note-level AI only on markdown notes and Fix Mermaid only in a fence", () => {
    const plain = labels(buildEditorMenu(base, actions));
    expect(plain).toContain("Continue Writing");
    expect(plain).not.toContain("Summarize Note");
    expect(plain).not.toContain("Fix Mermaid");
    const md = labels(buildEditorMenu({ ...base, isMarkdownNote: true, inMermaid: true }, actions));
    expect(md).toEqual(expect.arrayContaining(["Summarize Note", "Generate Title", "Fix Mermaid"]));
  });

  it("drops AI items when AI is off", () => {
    expect(labels(buildEditorMenu({ ...base, aiEnabled: false }, actions))).not.toContain("AI");
  });

  it("read-only editor: no writing actions at all", () => {
    const m = labels(buildEditorMenu({ ...base, readOnly: true, hasSelection: true }, actions));
    expect(m).toEqual(expect.arrayContaining(["Copy", "Select All", "Find"]));
    for (const l of ["Replace", "Format Document", "Continue Writing", "Undo"]) expect(m).not.toContain(l);
  });

  it("hides Format Document when no formatter is registered", () => {
    expect(labels(buildEditorMenu(base, { ...actions, format: undefined }))).not.toContain("Format Document");
  });
});

describe("buildPreviewMenu", () => {
  const a = { copy: noop, selectAll: noop, copyLink: noop };
  it("is read-only text actions, with Copy Link only on a link", () => {
    expect(labels(buildPreviewMenu({ hasSelection: false }, a))).toEqual(["Copy", "---", "Select All"]);
    expect(labels(buildPreviewMenu({ hasSelection: true, linkHref: "https://x.y" }, a))[0]).toBe("Copy Link Address");
    expect(labels(buildPreviewMenu({ hasSelection: true }, a))).not.toContain("Paste");
  });
});

describe("buildTabMenu", () => {
  const a = { togglePin: noop, rename: noop, lockToVault: noop, lockVault: noop, close: noop };
  const base = { isPinned: false, canRename: true, canLock: false, isVault: false, vaultUnlocked: false };

  it("plain tab: pin, rename, close", () => {
    expect(labels(buildTabMenu(base, a))).toEqual(["Pin Tab", "Rename", "---", "Close Tab"]);
  });
  it("pinned tab can't be closed", () => {
    const m = buildTabMenu({ ...base, isPinned: true }, a);
    expect(find(m, "Unpin Tab")).toBeTruthy();
    expect(find(m, "Close Tab")?.disabled).toBe(true);
  });
  it("offers Lock Vault Now only for a vault tab while the vault is unlocked", () => {
    expect(labels(buildTabMenu({ ...base, isVault: true }, a))).not.toContain("Lock Vault Now");
    expect(labels(buildTabMenu({ ...base, isVault: true, vaultUnlocked: true }, a))).toContain("Lock Vault Now");
  });
  it("settings tab has no rename", () => {
    expect(labels(buildTabMenu({ ...base, canRename: false }, a))).not.toContain("Rename");
  });
});

describe("other surfaces", () => {
  it("tab strip empty space opens new things", () => {
    expect(labels(buildTabStripMenu({ newNote: noop, newWhiteboard: noop, openFiles: noop, openFolder: noop })))
      .toEqual(["New Note", "New Whiteboard", "---", "Open File(s)", "Open Folder"]);
  });
  it("locked vault offers unlock / create", () => {
    expect(labels(buildVaultLockedMenu(true, noop))).toEqual(["Unlock Vault"]);
    expect(labels(buildVaultLockedMenu(false, noop))).toEqual(["Create Vault"]);
  });
  it("terminal has copy / paste / select all / clear and no Cut", () => {
    const m = buildTerminalMenu({ hasSelection: false }, { copy: noop, paste: noop, selectAll: noop, clear: noop });
    expect(labels(m)).toEqual(["Copy", "Paste", "---", "Select All", "---", "Clear"]);
    expect(find(m, "Copy")?.disabled).toBe(true);
  });
});
