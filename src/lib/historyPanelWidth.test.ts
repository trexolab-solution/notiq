import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HISTORY_FORM_MIN, HISTORY_PANEL_DEFAULT, HISTORY_PANEL_KEY, HISTORY_PANEL_MAX, HISTORY_PANEL_MIN,
  historyPanelOverlays, historyPanelWidth as w,
} from "./historyPanelWidth";

beforeEach(() => {
  const m = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  });
});

describe("history panel width", () => {
  it("docks beside the form only when both fit at their minimums", () => {
    expect(historyPanelOverlays(HISTORY_FORM_MIN + HISTORY_PANEL_MIN)).toBe(false);
    expect(historyPanelOverlays(HISTORY_FORM_MIN + HISTORY_PANEL_MIN - 1)).toBe(true);
    expect(historyPanelOverlays(NaN)).toBe(true);
  });
  it("max leaves the form its minimum, capped", () => {
    expect(w.max(2000)).toBe(HISTORY_PANEL_MAX);
    expect(w.max(800)).toBe(800 - HISTORY_FORM_MIN);
    expect(w.max(HISTORY_FORM_MIN + HISTORY_PANEL_MIN)).toBe(HISTORY_PANEL_MIN);
  });
  it("max fills most of the container when overlaying, never below min", () => {
    expect(w.max(500)).toBe(468);
    expect(w.max(200)).toBe(HISTORY_PANEL_MIN);
  });
  it("clamps to [min, max]", () => {
    expect(w.clamp(10, 1200)).toBe(HISTORY_PANEL_MIN);
    expect(w.clamp(9999, 1200)).toBe(HISTORY_PANEL_MAX);
    expect(w.clamp(9999, 900)).toBe(900 - HISTORY_FORM_MIN);
    expect(w.clamp(300.6, 1200)).toBe(301);
    expect(w.clamp(NaN, 1200)).toBe(HISTORY_PANEL_DEFAULT);
  });
  it("keeps the stored preference unclamped to the container", () => {
    expect(w.load()).toBe(HISTORY_PANEL_DEFAULT);
    localStorage.setItem(HISTORY_PANEL_KEY, "junk");
    expect(w.load()).toBe(HISTORY_PANEL_DEFAULT);
    w.save(600);
    expect(w.load()).toBe(600);
    expect(w.clamp(w.load(), 800)).toBe(440);
    localStorage.setItem(HISTORY_PANEL_KEY, "5");
    expect(w.load()).toBe(HISTORY_PANEL_MIN);
  });
});
