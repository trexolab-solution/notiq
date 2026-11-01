import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearDropTargets, dragLeave, dragMove, dropAt, findDropTarget, pickTarget, rectContains, registerDropTarget, toCssPoint,
  type DropTarget, type RectLike,
} from "./dropTargets";

const rect = (left: number, top: number, width: number, height: number): RectLike =>
  ({ left, top, right: left + width, bottom: top + height });
const el = (r: RectLike) => ({ getBoundingClientRect: () => r }) as unknown as Element;

function target(id: string, r: RectLike, opts: Partial<DropTarget> = {}): DropTarget & { onDrop: ReturnType<typeof vi.fn>; onHover: ReturnType<typeof vi.fn> } {
  return { id, element: () => el(r), enabled: () => true, onDrop: vi.fn(), onHover: vi.fn(), ...opts } as never;
}

afterEach(() => clearDropTargets());

describe("toCssPoint", () => {
  it("divides physical pixels by the device pixel ratio", () => {
    expect(toCssPoint({ x: 300, y: 150 }, 1.5)).toEqual({ x: 200, y: 100 });
    expect(toCssPoint({ x: 400, y: 200 }, 2)).toEqual({ x: 200, y: 100 });
    expect(toCssPoint({ x: 125, y: 125 }, 1.25)).toEqual({ x: 100, y: 100 });
  });
  it("treats a missing, zero or negative scale as 1", () => {
    for (const s of [0, -2, NaN, Infinity]) expect(toCssPoint({ x: 10, y: 20 }, s)).toEqual({ x: 10, y: 20 });
  });
});

describe("rectContains", () => {
  const r = rect(10, 20, 100, 50);
  it("includes the left/top edge and excludes the right/bottom edge", () => {
    expect(rectContains(r, { x: 10, y: 20 })).toBe(true);
    expect(rectContains(r, { x: 109.9, y: 69.9 })).toBe(true);
    expect(rectContains(r, { x: 110, y: 30 })).toBe(false);
    expect(rectContains(r, { x: 50, y: 70 })).toBe(false);
    expect(rectContains(r, { x: 9, y: 30 })).toBe(false);
  });
  it("never matches an empty (hidden) box", () => {
    expect(rectContains(rect(0, 0, 0, 0), { x: 0, y: 0 })).toBe(false);
  });
});

describe("pickTarget", () => {
  it("returns null when nothing is under the point", () => {
    expect(pickTarget([{ target: "a", rect: rect(0, 0, 10, 10) }], { x: 50, y: 50 })).toBeNull();
  });
  it("prefers the smallest box when boxes overlap", () => {
    const c = [{ target: "big", rect: rect(0, 0, 500, 500) }, { target: "small", rect: rect(100, 100, 50, 50) }];
    expect(pickTarget(c, { x: 120, y: 120 })).toBe("small");
    expect(pickTarget(c, { x: 10, y: 10 })).toBe("big");
  });
});

describe("registry", () => {
  it("hit-tests in CSS pixels after scaling the physical position", () => {
    const t = target("att", rect(100, 100, 200, 100));
    registerDropTarget(t);
    // (250, 250) physical at 2x is (125, 125) CSS: inside. At 1x it would be outside the box's bottom.
    expect(findDropTarget({ x: 250, y: 250 }, 2)).toBe(t);
    expect(findDropTarget({ x: 250, y: 250 }, 1)).toBeNull();
    // At 1.5x, (600, 300) is (400, 200): just right of the box.
    expect(findDropTarget({ x: 600, y: 300 }, 1.5)).toBeNull();
  });

  it("skips disabled targets and targets without an element", () => {
    registerDropTarget(target("off", rect(0, 0, 100, 100), { enabled: () => false }));
    registerDropTarget(target("gone", rect(0, 0, 100, 100), { element: () => null }));
    expect(findDropTarget({ x: 10, y: 10 }, 1)).toBeNull();
  });

  it("unregisters, and an old registration can't remove a newer one with the same id", () => {
    const a = target("x", rect(0, 0, 100, 100));
    const b = target("x", rect(0, 0, 100, 100));
    const offA = registerDropTarget(a);
    const offB = registerDropTarget(b);
    offA();
    expect(findDropTarget({ x: 5, y: 5 }, 1)).toBe(b);
    offB();
    expect(findDropTarget({ x: 5, y: 5 }, 1)).toBeNull();
  });

  it("reports hover enter/leave once per change", () => {
    const t = target("att", rect(0, 0, 100, 100));
    registerDropTarget(t);
    expect(dragMove({ x: 10, y: 10 }, 1)).toBe(true);
    expect(dragMove({ x: 20, y: 20 }, 1)).toBe(true);
    expect(t.onHover.mock.calls).toEqual([[true]]);
    expect(dragMove({ x: 500, y: 500 }, 1)).toBe(false);
    expect(t.onHover.mock.calls).toEqual([[true], [false]]);
    dragMove({ x: 10, y: 10 }, 1);
    dragLeave();
    expect(t.onHover.mock.calls.at(-1)).toEqual([false]);
  });

  it("delivers a drop to the target under it and says it handled it", () => {
    const t = target("att", rect(0, 0, 100, 100));
    registerDropTarget(t);
    dragMove({ x: 10, y: 10 }, 1);
    expect(dropAt(["C:/a.txt", "C:/b.png"], { x: 10, y: 10 }, 1)).toBe(true);
    expect(t.onDrop).toHaveBeenCalledWith(["C:/a.txt", "C:/b.png"]);
    expect(t.onHover.mock.calls.at(-1)).toEqual([false]);
  });

  it("leaves drops elsewhere to the default handler", () => {
    const t = target("att", rect(0, 0, 100, 100));
    registerDropTarget(t);
    expect(dropAt(["C:/a.md"], { x: 300, y: 300 }, 1)).toBe(false);
    expect(t.onDrop).not.toHaveBeenCalled();
  });
});
