import { describe, expect, it } from "vitest";
import { AREA_SELECTORS, classifyContextTarget, type ClosestLike } from "./target";

/** A stand-in element that "is inside" whatever simple selectors it's given. */
const el = (...inside: string[]): ClosestLike => ({
  closest: (sel: string) => (sel.split(",").some((s) => inside.includes(s.trim())) ? {} : null),
});

describe("classifyContextTarget", () => {
  it("gives nothing for a missing target or plain chrome", () => {
    expect(classifyContextTarget(null)).toBe("none");
    expect(classifyContextTarget(el(".status-bar"))).toBe("none");
    expect(classifyContextTarget(el(".settings-page"))).toBe("none");
  });

  it("routes Monaco (including its hidden textarea) to the editor menu", () => {
    expect(classifyContextTarget(el(".monaco-editor"))).toBe("editor");
    expect(classifyContextTarget(el(".monaco-editor", "textarea"))).toBe("editor");
  });

  it("gives text inputs the text menu, but not checkboxes", () => {
    expect(classifyContextTarget(el("textarea"))).toBe("text-field");
    expect(classifyContextTarget(el("input:not([type])"))).toBe("text-field");
    expect(classifyContextTarget(el("input[type='password']"))).toBe("text-field");
    expect(classifyContextTarget(el("input[type='checkbox']"))).toBe("none");
  });

  it("prefers a text field over the surface it sits in", () => {
    // Inline rename box inside the vault tree / a tab.
    expect(classifyContextTarget(el(".vt-scroll", "input[type='text']"))).toBe("text-field");
    expect(classifyContextTarget(el(".tab-strip", "input:not([type])"))).toBe("text-field");
  });

  it("leaves self-managed surfaces alone", () => {
    for (const s of AREA_SELECTORS.selfManaged.split(",").map((x) => x.trim())) {
      expect(classifyContextTarget(el(s))).toBe("self-managed");
    }
  });

  it("recognises preview, tab strip and the locked vault", () => {
    expect(classifyContextTarget(el(".prose-scroll"))).toBe("preview");
    expect(classifyContextTarget(el(".tab-strip"))).toBe("tab-strip");
    expect(classifyContextTarget(el("[data-context-area='vault-locked']"))).toBe("vault-locked");
  });
});
