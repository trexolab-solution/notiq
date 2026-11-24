// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { namesUnder } from "./useMarquee";

/** A scroller with rows at fixed positions (happy-dom has no layout, so each row reports a rectangle). */
function scrollerWith(rows: Record<string, [number, number, number, number]>): HTMLElement {
  const root = document.createElement("div");
  for (const [name, [left, top, width, height]] of Object.entries(rows)) {
    const row = document.createElement("div");
    row.dataset.name = name;
    row.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) });
    root.append(row);
  }
  return root;
}

describe("namesUnder", () => {
  const rows = scrollerWith({ a: [0, 0, 100, 30], b: [0, 30, 100, 30], c: [0, 60, 100, 30], d: [120, 0, 100, 30] });

  it("selects every row the band touches, even partly", () => {
    expect(namesUnder(rows, 10, 20, 50, 20)).toEqual(["a", "b"]);
    expect(namesUnder(rows, 0, 0, 300, 100)).toEqual(["a", "b", "c", "d"]);
  });

  it("selects nothing for a band on empty space", () => {
    expect(namesUnder(rows, 0, 200, 50, 40)).toEqual([]);
    expect(namesUnder(rows, 230, 0, 20, 20)).toEqual([]);
  });

  it("does not count a row the band only borders", () => {
    expect(namesUnder(rows, 0, 90, 100, 10)).toEqual([]);
  });
});
