// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { KeyRound } from "lucide-react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const historyList = vi.fn();
const historyRestore = vi.fn(async () => {});
vi.mock("../../lib/vault", async (orig) => ({
  ...(await orig<typeof import("../../lib/vault")>()),
  vaultHistoryList: (p: string) => historyList(p),
  vaultHistoryGet: async () => ({ ext: "md", content: "old body" }),
  vaultHistoryRestore: () => historyRestore(),
  vaultReadFile: async () => ({ ext: "md", content: "restored body" }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { EntryHeader, EntryLayout } = await import("./EntryParts");
const { HISTORY_PANEL_DEFAULT, HISTORY_PANEL_KEY } = await import("../../lib/historyPanelWidth");
type Tab = import("../../types").Tab;

const tab = { id: "t1", title: "Google", filePath: "vault/google.login", content: "", isDirty: false } as unknown as Tab;
const revs = [{ index: 0, updated: Date.now() - 60_000, size: 120 }, { index: 1, updated: Date.now() - 120_000, size: 100 }];

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const press = (el: Element, key: string) =>
  act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });

beforeEach(async () => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  });
  // Wide enough to dock beside the form.
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1200);
  historyList.mockReset();
  historyList.mockResolvedValue(revs);
  historyRestore.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<EntryLayout tab={tab}><EntryHeader icon={KeyRound} title="Login" tab={tab} /><input aria-label="Name" /></EntryLayout>);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const panel = () => q('[role="complementary"]');
const openPanel = async () => { await click(button("History")); await flush(); };

describe("History side panel", () => {
  it("toggles from the header button, which shows a pressed state", async () => {
    expect(panel()).toBeNull();
    expect(button("History").getAttribute("aria-pressed")).toBe("false");
    await openPanel();
    expect(panel()?.getAttribute("aria-label")).toBe("History of Google");
    expect(button("History").getAttribute("aria-pressed")).toBe("true");
    expect(panel()?.textContent).toContain("Previous save");
    expect(panel()?.textContent).not.toContain("old body"); // previewed masked
    await click(button("Show secrets"));
    expect(panel()?.textContent).toContain("old body");
    await click(button("History"));
    expect(panel()).toBeNull();
  });

  it("has a keyboard-resizable separator that persists the width and resets on double-click", async () => {
    await openPanel();
    const sep = q('[role="separator"]')!;
    expect(sep.getAttribute("aria-orientation")).toBe("vertical");
    expect(sep.getAttribute("aria-valuenow")).toBe(String(HISTORY_PANEL_DEFAULT));
    await press(sep, "ArrowLeft"); // left-edge handle: moving left widens the panel
    expect(sep.getAttribute("aria-valuenow")).toBe(String(HISTORY_PANEL_DEFAULT + 16));
    expect(panel()!.style.width).toBe(`${HISTORY_PANEL_DEFAULT + 16}px`);
    expect(localStorage.getItem(HISTORY_PANEL_KEY)).toBe(String(HISTORY_PANEL_DEFAULT + 16));
    await act(async () => { sep.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(sep.getAttribute("aria-valuenow")).toBe(String(HISTORY_PANEL_DEFAULT));
  });

  it("closes on Escape only while focus is inside it, and from its X button", async () => {
    await openPanel();
    const name = q<HTMLInputElement>('input[aria-label="Name"]')!;
    name.focus();
    await press(name, "Escape");
    expect(panel()).not.toBeNull();
    const sep = q<HTMLElement>('[role="separator"]')!;
    sep.focus();
    await press(sep, "Escape");
    expect(panel()).toBeNull();
    await openPanel();
    await click(q('[aria-label="Close history"]')!);
    expect(panel()).toBeNull();
  });

  it("stays open after a confirmed restore and refreshes its list", async () => {
    await openPanel();
    expect(historyList).toHaveBeenCalledTimes(1);
    await click(button("Restore this version"));
    const dialog = q('[role="alertdialog"]')!;
    const confirm = [...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Restore")!;
    await click(confirm);
    await flush();
    expect(historyRestore).toHaveBeenCalledTimes(1);
    expect(panel()).not.toBeNull();
    expect(historyList).toHaveBeenCalledTimes(2);
  });
});
