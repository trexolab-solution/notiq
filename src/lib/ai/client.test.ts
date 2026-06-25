import { describe, it, expect, vi } from "vitest";

// client.ts imports the Zustand store (which touches localStorage at module load)
// and the Tauri bridge. None of that is needed to exercise the pure text helpers,
// so stub those modules out before importing the unit under test.
vi.mock("../../store", () => ({
  useAppStore: { getState: () => ({ aiProvider: "cloud", aiModel: "test-model" }) },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../tauriWindow", () => ({ isTauri: false }));

import {
  stripCodeFences,
  cleanCompletion,
  ensureMermaidBlock,
  baseUrlFor,
  CLOUD_BASE,
  LOCAL_BASE,
} from "./client";

describe("baseUrlFor", () => {
  it("maps provider to the right base URL", () => {
    expect(baseUrlFor("local")).toBe(LOCAL_BASE);
    expect(baseUrlFor("cloud")).toBe(CLOUD_BASE);
  });
});

describe("stripCodeFences", () => {
  it("unwraps a fenced block with a language tag", () => {
    expect(stripCodeFences("```js\nconsole.log(1)\n```")).toBe("console.log(1)");
  });
  it("unwraps a bare fenced block", () => {
    expect(stripCodeFences("```\nfoo\n```")).toBe("foo");
  });
  it("leaves unfenced text untouched (trimmed)", () => {
    expect(stripCodeFences("  hello  ")).toBe("hello");
  });
});

describe("cleanCompletion", () => {
  it("removes the cursor marker", () => {
    expect(cleanCompletion("ab<|cursor|>cd", "", "")).toBe("abcd");
  });

  it("strips a stray code fence", () => {
    expect(cleanCompletion("```\nfoo\n```", "", "")).toBe("foo");
  });

  it("keeps only the first line in singleLine mode", () => {
    expect(cleanCompletion("line1\nline2", "", "", { singleLine: true })).toBe("line1");
  });

  it("drops a leading newline in sameLine mode", () => {
    expect(cleanCompletion("\n  continued", "", "", { sameLine: true })).toBe("continued");
  });

  it("trims completion text that duplicates the tail of the prefix", () => {
    expect(cleanCompletion("value = 5", "const value", "")).toBe(" = 5");
  });

  it("forces a leading newline in newLine mode", () => {
    expect(cleanCompletion("next", "# Heading", "", { newLine: true })).toBe("\nnext");
  });
});

describe("ensureMermaidBlock", () => {
  it("wraps raw mermaid code in a fenced block", () => {
    expect(ensureMermaidBlock("graph TD\nA-->B")).toBe("```mermaid\ngraph TD\nA-->B\n```");
  });

  it("preserves an existing mermaid fence", () => {
    const block = "```mermaid\ngraph TD; A-->B\n```";
    expect(ensureMermaidBlock(block)).toBe(block);
  });

  it("re-tags a generic fence as mermaid", () => {
    expect(ensureMermaidBlock("```\ngraph TD; A-->B\n```")).toBe(
      "```mermaid\ngraph TD; A-->B\n```",
    );
  });
});
