import { describe, expect, it } from "vitest";
import { isAtBottom, pickActiveSection, type SectionBox } from "./scrollSpy";

// Three sections, 600px tall each, laid out from y=0 at scrollTop 0; reading line at 80px.
const boxes = (scrollTop: number): SectionBox[] => [
  { id: "general", top: 0 - scrollTop, bottom: 600 - scrollTop },
  { id: "editor", top: 600 - scrollTop, bottom: 1200 - scrollTop },
  { id: "about", top: 1200 - scrollTop, bottom: 1400 - scrollTop },
];
const vp = (atBottom = false) => ({ offset: 80, height: 700, atBottom });

describe("pickActiveSection", () => {
  it("returns null without sections", () => {
    expect(pickActiveSection([], vp())).toBeNull();
  });

  it("marks the first section before anything reaches the reading line", () => {
    expect(pickActiveSection([{ id: "a", top: 200, bottom: 400 }], vp())).toBe("a");
  });

  it("picks the last section whose top has reached the reading line", () => {
    expect(pickActiveSection(boxes(0), vp())).toBe("general");
    expect(pickActiveSection(boxes(518), vp())).toBe("general");
    expect(pickActiveSection(boxes(520), vp())).toBe("editor");
    expect(pickActiveSection(boxes(900), vp())).toBe("editor");
  });

  it("at the bottom, picks the last visible section even if it never reached the line", () => {
    // scrollTop 700: about.top = 500 (below the line) but the page can't scroll further.
    expect(pickActiveSection(boxes(700), vp(false))).toBe("editor");
    expect(pickActiveSection(boxes(700), vp(true))).toBe("about");
  });

  it("works with hidden sections omitted (filtered search)", () => {
    const filtered = [boxes(0)[0], { id: "about", top: 600, bottom: 800 }];
    expect(pickActiveSection(filtered, vp())).toBe("general");
  });
});

describe("isAtBottom", () => {
  it("tolerates sub-pixel rounding", () => {
    expect(isAtBottom({ scrollTop: 698.5, clientHeight: 300, scrollHeight: 1000 })).toBe(true);
    expect(isAtBottom({ scrollTop: 600, clientHeight: 300, scrollHeight: 1000 })).toBe(false);
  });
});
