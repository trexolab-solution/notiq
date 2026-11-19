import { afterEach, describe, expect, it, vi } from "vitest";
import { computePopoverPos, placeTooltip } from "./popoverPosition";

afterEach(() => vi.unstubAllGlobals());

const anchorAt = (r: { top: number; bottom: number; left: number; width: number }) =>
  ({ getBoundingClientRect: () => r }) as unknown as HTMLElement;

describe("computePopoverPos", () => {
  it("opens below when there is room", () => {
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
    const pos = computePopoverPos(anchorAt({ top: 100, bottom: 130, left: 50, width: 120 }), { maxHeight: 300 });
    expect(pos).toEqual({ top: 134, left: 50, width: 120, flipUp: false });
  });
  it("flips up near the bottom when there is more space above", () => {
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800 });
    const pos = computePopoverPos(anchorAt({ top: 700, bottom: 730, left: 50, width: 120 }), { maxHeight: 300 });
    expect(pos.flipUp).toBe(true);
    expect(pos.bottom).toBe(104);
    expect(pos.top).toBeUndefined();
  });
  it("does not flip when above is even tighter", () => {
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 400 });
    const pos = computePopoverPos(anchorAt({ top: 50, bottom: 80, left: 0, width: 100 }), { maxHeight: 500 });
    expect(pos.flipUp).toBe(false);
  });
  it("applies minWidth, caps to the viewport and clamps the right edge", () => {
    vi.stubGlobal("window", { innerWidth: 500, innerHeight: 800 });
    const pos = computePopoverPos(anchorAt({ top: 0, bottom: 20, left: 450, width: 40 }), { minWidth: 200, maxHeight: 100 });
    expect(pos.width).toBe(200);
    expect(pos.left).toBe(500 - 200 - 8);
    const wide = computePopoverPos(anchorAt({ top: 0, bottom: 20, left: 0, width: 40 }), { minWidth: 9999, maxHeight: 100 });
    expect(wide.width).toBe(484);
  });
});

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height });
const vp = { width: 800, height: 600 };
const size = { width: 100, height: 40 };

describe("placeTooltip", () => {
  it("places below and centered by default", () => {
    expect(placeTooltip(rect(300, 100, 60, 20), size, vp)).toEqual({ top: 126, left: 280, placement: "bottom" });
  });
  it("flips to top when there is no room below", () => {
    const r = placeTooltip(rect(300, 560, 60, 20), size, vp);
    expect(r.placement).toBe("top");
    expect(r.top).toBe(560 - 6 - 40);
  });
  it("keeps the preferred side if the opposite is no better", () => {
    const r = placeTooltip(rect(300, 10, 60, 20), { width: 100, height: 700 }, vp);
    expect(r.placement).toBe("bottom");
  });
  it("shifts along the cross axis to stay inside the margin", () => {
    expect(placeTooltip(rect(0, 100, 10, 10), size, vp).left).toBe(8);
    expect(placeTooltip(rect(790, 100, 10, 10), size, vp).left).toBe(800 - 8 - 100);
  });
  it("supports right/left placement with flip", () => {
    const r = placeTooltip(rect(100, 100, 20, 20), size, vp, { placement: "right" });
    expect(r).toEqual({ top: 90, left: 126, placement: "right" });
    const f = placeTooltip(rect(750, 100, 20, 20), size, vp, { placement: "right" });
    expect(f.placement).toBe("left");
    expect(f.left).toBe(750 - 6 - 100);
  });
});
