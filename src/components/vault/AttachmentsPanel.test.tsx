// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => dialogOpen(...a), save: vi.fn(), ask: vi.fn() }));
const fsStat = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  stat: (p: string) => fsStat(p), readFile: async () => new Uint8Array([1, 2, 3]),
  exists: async () => true, mkdir: async () => {},
}));

type Att = import("../../lib/vault").VaultAttachment;
let stored: Att[] = [];
const attachAdd = vi.fn(async (_p: string, name: string) => {
  const a: Att = { id: `id-${name}`, name, mime: "", size: 3, added: 0 };
  stored = [...stored, a];
  return a;
});
const attachRemove = vi.fn(async (_p: string, id: string) => { stored = stored.filter((a) => a.id !== id); });
vi.mock("../../lib/vault", async (orig) => ({
  ...(await orig<typeof import("../../lib/vault")>()),
  vaultAttachList: async () => stored,
  vaultAttachAdd: (p: string, n: string) => attachAdd(p, n),
  vaultAttachRemove: (p: string, id: string) => attachRemove(p, id),
}));
vi.mock("../../lib/attachmentLimits", async (orig) => ({
  ...(await orig<typeof import("../../lib/attachmentLimits")>()),
  vaultAttachmentsUsed: async () => 0,
}));
vi.mock("../../lib/vaultDir", () => ({ resolveVaultDir: async () => "C:/vault" }));
const toastInfo = vi.fn();
const toastError = vi.fn();
vi.mock("../../lib/toast", () => ({
  toast: { info: (...a: unknown[]) => toastInfo(...a), error: (...a: unknown[]) => toastError(...a), success: vi.fn(), dismiss: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { AttachmentsPanel, FOLDER_ERROR, REMOVE_UNDO_MS } = await import("./AttachmentsPanel");
const { EntryLayout } = await import("./EntryParts");
const { useAppStore } = await import("../../store");
const { useVaultStore } = await import("../../store/vaultStore");
const { clearDropTargets, dragLeave, dragMove, dropAt } = await import("../../lib/dropTargets");
type Tab = import("../../types").Tab;

const PATH = "C:/vault/Bank.nqv";
const tab = { id: "t1", title: "Bank", filePath: PATH, content: JSON.stringify({ title: "Bank" }), isDirty: false } as unknown as Tab;
const MB = 1024 * 1024;

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(50); });
const btn = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text))!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const live = () => document.querySelector('[role="status"][aria-live="polite"]')!.textContent;

async function render(files: Att[] = []) {
  stored = files;
  await act(async () => { root.render(<EntryLayout tab={tab}><AttachmentsPanel tab={tab} /></EntryLayout>); });
  await flush();
  await click(byText("Attachments"));
}

beforeEach(() => {
  vi.useFakeTimers();
  dialogOpen.mockReset(); fsStat.mockReset(); attachAdd.mockClear(); attachRemove.mockClear();
  toastInfo.mockReset(); toastError.mockReset();
  useAppStore.setState({ tabs: [tab], activeTabId: tab.id });
  useVaultStore.setState({ unlocked: true });
  // happy-dom has no layout: give the entry's drop area a box.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return (this.hasAttribute("data-entry-drop")
      ? { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0 }
      : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }) as DOMRect;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  clearDropTargets();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Attachments list", () => {
  it("explains how to add files when empty", async () => {
    await render();
    expect(document.querySelector("[data-empty]")?.textContent).toContain("Drop files here or Add file");
    expect(byText("Add file")).toBeTruthy();
    const group = document.querySelector('[role="group"]')!;
    expect(document.getElementById(group.getAttribute("aria-describedby")!)?.textContent).toMatch(/drop files/i);
  });

  it("shows each file with its size and actions named after it", async () => {
    await render([
      { id: "a", name: "scan.png", mime: "image/png", size: 2 * MB, added: 0 },
      { id: "b", name: "backup.zip", mime: "application/zip", size: 1024, added: 0 },
    ]);
    const rows = document.querySelectorAll("li[data-list-row]");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("2.0 MB");
    expect(btn("Open scan.png")).toBeTruthy();
    expect(btn("Save scan.png as")).toBeTruthy();
    expect(btn("Remove scan.png")).toBeTruthy();
    expect(btn("Open backup.zip")).toBeNull(); // not previewable: Save as only
    expect(btn("Save backup.zip as")).toBeTruthy();
  });
});

describe("Adding", () => {
  it("adds picked files, shows inline errors for the ones that don't fit, announces and focuses the new row", async () => {
    await render();
    dialogOpen.mockResolvedValue(["C:/docs/ok.txt", "C:/docs/huge.pdf"]);
    fsStat.mockImplementation(async (p: string) => ({ size: p.includes("huge") ? 6 * MB : 3, isDirectory: false }));
    await click(byText("Add file"));
    await flush();
    expect(attachAdd).toHaveBeenCalledTimes(1);
    expect(attachAdd).toHaveBeenCalledWith(PATH, "ok.txt");
    const err = document.querySelector('[data-job="error"]')!;
    expect(err.textContent).toContain("huge.pdf");
    expect(err.textContent).toMatch(/at most 5 MB/);
    expect(live()).toMatch(/Attached 1 file to Bank\..*huge\.pdf/);
    expect(document.activeElement).toBe(btn("Open ok.txt"));
    await click(btn("Dismiss error for huge.pdf")!);
    expect(document.querySelector("[data-job]")).toBeNull();
    expect(document.activeElement?.hasAttribute("data-list-add")).toBe(true);
  });
});

describe("Drag and drop", () => {
  it("highlights the entry and attaches dropped files instead of opening them", async () => {
    await render();
    await act(async () => { expect(dragMove({ x: 200, y: 200 }, 2)).toBe(true); });
    expect(document.querySelector("[data-drop-highlight]")?.textContent).toContain("Drop to attach to Bank");
    fsStat.mockResolvedValue({ size: 3, isDirectory: false });
    let handled = false;
    await act(async () => { handled = dropAt(["C:/a.txt", "C:/b.txt"], { x: 200, y: 200 }, 2); });
    await flush();
    expect(handled).toBe(true);
    expect(document.querySelector("[data-drop-highlight]")).toBeNull();
    expect(attachAdd.mock.calls.map((c) => c[1])).toEqual(["a.txt", "b.txt"]);
    expect(live()).toContain("Attached 2 files to Bank.");
  });

  it("refuses folders with a message", async () => {
    await render();
    fsStat.mockResolvedValue({ size: 0, isDirectory: true });
    await act(async () => { dropAt(["C:/photos"], { x: 10, y: 10 }, 1); });
    await flush();
    expect(attachAdd).not.toHaveBeenCalled();
    expect(document.querySelector('[data-job="error"]')?.textContent).toContain(FOLDER_ERROR);
  });

  it("ignores drops while the entry isn't the active tab or the vault is locked", async () => {
    await render();
    await act(async () => { useAppStore.setState({ activeTabId: "other" }); });
    expect(dropAt(["C:/a.txt"], { x: 10, y: 10 }, 1)).toBe(false);
    await act(async () => { useAppStore.setState({ activeTabId: tab.id }); useVaultStore.setState({ unlocked: false }); });
    expect(dropAt(["C:/a.txt"], { x: 10, y: 10 }, 1)).toBe(false);
    await act(async () => { dragLeave(); });
  });
});

describe("Removing", () => {
  const files: Att[] = [
    { id: "a", name: "one.txt", mime: "text/plain", size: 10, added: 0 },
    { id: "b", name: "two.txt", mime: "text/plain", size: 10, added: 0 },
  ];
  const undoOf = () => (toastInfo.mock.calls.at(-1)![1] as { actions: { onClick: () => void }[] }).actions[0];

  it("hides the row at once, moves focus to the next row and Undo brings it back without touching the vault", async () => {
    await render(files);
    await click(btn("Remove one.txt")!);
    expect(btn("Remove one.txt")).toBeNull();
    expect(document.activeElement).toBe(btn("Open two.txt"));
    expect(live()).toContain("Removed one.txt");
    await act(async () => { undoOf().onClick(); });
    await flush();
    expect(btn("Remove one.txt")).toBeTruthy();
    expect(document.activeElement).toBe(btn("Open one.txt"));
    await act(async () => { await vi.advanceTimersByTimeAsync(REMOVE_UNDO_MS + 100); });
    expect(attachRemove).not.toHaveBeenCalled();
  });

  it("applies the removal when the Undo window ends", async () => {
    await render(files);
    await click(btn("Remove two.txt")!);
    expect(document.activeElement).toBe(btn("Open one.txt"));
    expect(attachRemove).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(REMOVE_UNDO_MS + 100); });
    expect(attachRemove).toHaveBeenCalledWith(PATH, "b");
    expect(document.querySelectorAll("li[data-list-row]")).toHaveLength(1);
  });

  it("applies pending removals when the panel goes away", async () => {
    await render(files);
    await click(btn("Remove one.txt")!);
    await act(async () => root.unmount());
    root = createRoot(host);
    expect(attachRemove).toHaveBeenCalledWith(PATH, "a");
  });
});
