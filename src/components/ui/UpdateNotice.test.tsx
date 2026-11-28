// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";

let state = { status: "uptodate", version: null as string | null, dialogOpen: false };
const listeners = new Set<() => void>();
const openDialog = vi.fn();
vi.mock("../../lib/updater", () => ({
  updater: { getState: () => state, subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l); }, openDialog: () => openDialog() },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { UpdateNotice, UPDATE_LATER_MS } = await import("./UpdateNotice");
const set = (next: Partial<typeof state>) => act(async () => { state = { ...state, ...next }; listeners.forEach((l) => l()); });
const card = () => document.querySelector("[data-update-notice]");
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;

afterEach(() => vi.useRealTimers());

it("shows when an update is available, goes away on Later, and asks again after a while", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<UpdateNotice />); });
  expect(card()).toBeNull();
  await set({ status: "available", version: "9.0.0" });
  expect(card()?.textContent).toContain("Update available");
  // Below every dialog backdrop (z-50 and up), so it can't be clicked over one.
  expect(Number(/z-\[(\d+)\]/.exec(card()!.className)![1])).toBeLessThan(50);
  expect(card()?.textContent).toContain("new version 9.0.0");
  await act(async () => { button("Update now").click(); });
  expect(openDialog).toHaveBeenCalledTimes(1);
  await set({ dialogOpen: true });
  expect(card()).toBeNull();
  await set({ dialogOpen: false });
  await act(async () => { button("Later").click(); });
  expect(card()).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_LATER_MS + 100); });
  expect(card()).toBeTruthy();
  // A newer version doesn't wait for the snooze.
  await act(async () => { button("Later").click(); });
  await set({ version: "9.1.0" });
  expect(card()?.textContent).toContain("9.1.0");
  act(() => root.unmount());
});
