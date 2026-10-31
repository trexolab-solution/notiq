import { describe, expect, it } from "vitest";
import { clampMenuPosition, nextFocusIndex } from "./position";

describe("clampMenuPosition", () => {
  it("opens at the cursor when it fits", () => {
    expect(clampMenuPosition(100, 100, 200, 150, 1000, 800)).toEqual({ left: 100, top: 100 });
  });
  it("flips left / up near the right / bottom edge", () => {
    expect(clampMenuPosition(950, 750, 200, 150, 1000, 800)).toEqual({ left: 750, top: 600 });
  });
  it("pins inside the viewport when it fits neither way", () => {
    expect(clampMenuPosition(100, 100, 200, 700, 1000, 750)).toEqual({ left: 100, top: 42 });
    expect(clampMenuPosition(100, 100, 200, 900, 1000, 750).top).toBe(8);
  });
});

describe("nextFocusIndex", () => {
  // item, separator, disabled item, item, label
  const enabled = [true, false, false, true, false];
  it("skips separators, labels and disabled items, wrapping around", () => {
    expect(nextFocusIndex(enabled, -1, 1)).toBe(0);
    expect(nextFocusIndex(enabled, 0, 1)).toBe(3);
    expect(nextFocusIndex(enabled, 3, 1)).toBe(0);
    expect(nextFocusIndex(enabled, -1, -1)).toBe(3);
    expect(nextFocusIndex(enabled, 0, -1)).toBe(3);
  });
  it("returns -1 when nothing can take focus", () => {
    expect(nextFocusIndex([false, false], -1, 1)).toBe(-1);
  });
});
