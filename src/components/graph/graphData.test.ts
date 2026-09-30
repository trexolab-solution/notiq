import { describe, it, expect } from "vitest";
import { degreeMap, hslToHex, luminance, nodeColor, nodeRadius, rid, truncate } from "./graphData";

describe("luminance", () => {
  it("returns 0 for black and 1 for white", () => {
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#ffffff")).toBeCloseTo(1);
  });
  it("pads short hex strings", () => {
    expect(luminance("#fff")).not.toBeNaN();
  });
});

describe("hslToHex", () => {
  it("converts pure red", () => {
    expect(hslToHex(0, 100, 50)).toBe("#ff0000");
  });
  it("converts grey (0 saturation) regardless of hue", () => {
    expect(hslToHex(0, 0, 50)).toBe(hslToHex(180, 0, 50));
  });
});

describe("nodeColor", () => {
  it("is deterministic for the same id", () => {
    expect(nodeColor("note-1", false)).toBe(nodeColor("note-1", false));
  });
  it("differs between light and dark themes for the same id", () => {
    expect(nodeColor("note-1", true)).not.toBe(nodeColor("note-1", false));
  });
});

describe("truncate", () => {
  it("leaves short strings untouched", () => {
    expect(truncate("short")).toBe("short");
  });
  it("truncates long strings with an ellipsis", () => {
    const long = "a".repeat(30);
    expect(truncate(long, 10)).toBe("aaaaaaaaa…");
    expect(truncate(long, 10)).toHaveLength(10);
  });
});

describe("degreeMap", () => {
  it("counts each link endpoint once per side", () => {
    const nodes = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
    const links = [{ source: "a", target: "b" }, { source: "a", target: "c" }];
    expect(degreeMap(nodes, links)).toEqual({ a: 2, b: 1, c: 1 });
  });
  it("defaults isolated nodes to 0", () => {
    const nodes = [{ id: "solo", name: "Solo" }];
    expect(degreeMap(nodes, [])).toEqual({ solo: 0 });
  });
});

describe("nodeRadius", () => {
  it("grows with degree but never shrinks below the base radius", () => {
    expect(nodeRadius(0)).toBe(2);
    expect(nodeRadius(-5)).toBe(2);
    expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(0));
  });
});

describe("rid", () => {
  it("returns string endpoints unchanged", () => {
    expect(rid("note-1")).toBe("note-1");
  });
  it("extracts id from object endpoints", () => {
    expect(rid({ id: "note-2" })).toBe("note-2");
  });
  it("falls back to empty string when id is missing", () => {
    expect(rid({})).toBe("");
  });
});
