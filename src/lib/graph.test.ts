import { describe, it, expect } from "vitest";
import { buildGraphData } from "./graph";
import type { Tab } from "../types";

const tab = (o: Partial<Tab>): Tab => ({
  id: "x", kind: "note", title: "T", content: "", isDirty: false,
  cursorPosition: { line: 1, column: 1 }, scrollPosition: 0, editorMode: "split",
  createdAt: 0, updatedAt: 0, isPinned: false, ...o,
});

describe("buildGraphData with vault notes", () => {
  it("hides locked vault notes: no node, and nothing can link to them", () => {
    const pub = tab({ id: "a", title: "Public", content: "see [[Secret]]" });
    const sec = tab({ id: "s", title: "Secret", filePath: "/n/secret.nqv", vaultLocked: true });
    const g = buildGraphData([pub, sec]);
    expect(g.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(g.links).toEqual([]);
  });

  it("shows unlocked vault notes like any other note", () => {
    const pub = tab({ id: "a", title: "Public", content: "" });
    const sec = tab({ id: "s", title: "Secret", filePath: "/n/secret.nqv", content: "back to [[Public]]" });
    const g = buildGraphData([pub, sec]);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["a", "s"]);
    expect(g.links).toHaveLength(1);
  });
});
