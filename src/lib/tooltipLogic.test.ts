import { describe, expect, it } from "vitest";
import {
  TOOLTIP_SHOW_DELAY, TOOLTIP_WARM_WINDOW, isWarm, markHidden, markShown, parseShortcut, showDelay, type WarmState,
} from "./tooltipLogic";
import { placeTooltip } from "./popoverPosition";

const cold: WarmState = { visible: false, lastHiddenAt: 0 };

describe("tooltip warm-up / cool-down", () => {
  it("waits the full delay when cold", () => {
    expect(showDelay(cold, 10_000)).toBe(TOOLTIP_SHOW_DELAY);
    expect(TOOLTIP_SHOW_DELAY).toBe(500);
    expect(showDelay(cold, 10_000, 800)).toBe(800);
  });

  it("is instant while another tooltip is visible", () => {
    expect(showDelay(markShown(cold), 10_000)).toBe(0);
  });

  it("stays warm for the cool-down window after a visible tooltip hides", () => {
    const s = markHidden(markShown(cold), 10_000, true);
    expect(isWarm(s, 10_000 + TOOLTIP_WARM_WINDOW - 1)).toBe(true);
    expect(showDelay(s, 10_000 + 50)).toBe(0);
    expect(isWarm(s, 10_000 + TOOLTIP_WARM_WINDOW)).toBe(false);
    expect(showDelay(s, 10_000 + TOOLTIP_WARM_WINDOW + 1)).toBe(TOOLTIP_SHOW_DELAY);
  });

  it("a tooltip that never showed does not warm the system", () => {
    expect(markHidden(cold, 10_000, false)).toBe(cold);
    expect(showDelay(markHidden(cold, 10_000, false), 10_010)).toBe(TOOLTIP_SHOW_DELAY);
  });

  it("negative delays clamp to 0", () => {
    expect(showDelay(cold, 1, -5)).toBe(0);
  });
});

describe("parseShortcut", () => {
  it("splits keys and chords", () => {
    expect(parseShortcut("Ctrl+N")).toEqual([["Ctrl", "N"]]);
    expect(parseShortcut("Ctrl+Shift+`")).toEqual([["Ctrl", "Shift", "`"]]);
    expect(parseShortcut("Ctrl+K Ctrl+S")).toEqual([["Ctrl", "K"], ["Ctrl", "S"]]);
    expect(parseShortcut("Enter")).toEqual([["Enter"]]);
  });
  it("keeps a literal plus key", () => {
    expect(parseShortcut("Ctrl++")).toEqual([["Ctrl", "+"]]);
    expect(parseShortcut("Ctrl+Shift++")).toEqual([["Ctrl", "Shift", "+"]]);
  });
});

describe("placeTooltip", () => {
  const vp = { width: 1000, height: 800 };
  const rect = (left: number, top: number, w = 20, h = 20) =>
    ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const size = { width: 100, height: 24 };

  it("centres below the anchor by default", () => {
    expect(placeTooltip(rect(400, 100), size, vp)).toEqual({ top: 126, left: 360, placement: "bottom" });
  });

  it("flips above near the bottom edge", () => {
    const p = placeTooltip(rect(400, 780), size, vp);
    expect(p.placement).toBe("top");
    expect(p.top).toBe(780 - 6 - 24);
  });

  it("does not flip when the other side is even tighter", () => {
    expect(placeTooltip(rect(400, 10, 20, 770), size, vp).placement).toBe("bottom");
  });

  it("shifts horizontally to stay inside the viewport", () => {
    expect(placeTooltip(rect(0, 100), size, vp).left).toBe(8);
    expect(placeTooltip(rect(990, 100, 10), size, vp).left).toBe(1000 - 8 - 100);
  });

  it("supports right placement with flip to left", () => {
    expect(placeTooltip(rect(40, 300), size, vp, { placement: "right" })).toEqual({ top: 298, left: 66, placement: "right" });
    expect(placeTooltip(rect(950, 300), size, vp, { placement: "right" }).placement).toBe("left");
  });
});
