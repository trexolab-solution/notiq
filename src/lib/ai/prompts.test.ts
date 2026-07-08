import { describe, it, expect } from "vitest";
import { detectDiagramIntent, chatSystem } from "./prompts";

describe("detectDiagramIntent", () => {
  it("matches strong diagram keywords", () => {
    expect(detectDiagramIntent("let's create a flowchart")).toBe(true);
    expect(detectDiagramIntent("visualize the data")).toBe(true);
    expect(detectDiagramIntent("a sequence diagram of the login")).toBe(true);
  });

  it("matches the weak intro + visual-noun pattern", () => {
    expect(detectDiagramIntent("here's a visual of the architecture")).toBe(true);
    expect(detectDiagramIntent("let's show the workflow")).toBe(true);
  });

  it("does not fire on ordinary prose", () => {
    expect(detectDiagramIntent("just some plain text here")).toBe(false);
    expect(detectDiagramIntent("the quick brown fox")).toBe(false);
  });
});

describe("chatSystem", () => {
  it("has no active-document block when no files are given", () => {
    expect(chatSystem()).toContain("(No active note/file is attached.)");
    expect(chatSystem([])).toContain("(No active note/file is attached.)");
  });

  it("single note produces one ACTIVE NOTE block with its title", () => {
    const out = chatSystem([{ title: "My Note", content: "hello world" }]);
    expect(out).toContain('--- ACTIVE NOTE ("My Note")');
    expect(out).toContain("hello world");
    expect(out).toContain("--- END ---");
    expect(out).not.toMatch(/FILE \d\/\d/);
  });

  it("single code file produces one ACTIVE FILE block naming the language", () => {
    const out = chatSystem([{ content: "print(1)", fileName: "a.py", language: "python" }]);
    expect(out).toContain('--- ACTIVE FILE ("a.py", python)');
    expect(out).toContain("print(1)");
  });

  it("2+ files produce numbered FILE i/N blocks for every non-empty file", () => {
    const out = chatSystem([
      { title: "Note A", content: "content A" },
      { content: "print(2)", fileName: "b.py", language: "python" },
    ]);
    expect(out).toContain("2 files are attached below");
    expect(out).toContain('--- FILE 1/2 ("Note A")');
    expect(out).toContain("content A");
    expect(out).toContain("--- END 1/2 ---");
    expect(out).toContain('--- FILE 2/2 ("b.py", python)');
    expect(out).toContain("print(2)");
    expect(out).toContain("--- END 2/2 ---");
    expect(out).not.toContain("ACTIVE NOTE");
    expect(out).not.toContain("ACTIVE FILE");
  });

  it("skips empty files in the multi-file block output", () => {
    const out = chatSystem([
      { title: "Empty", content: "   " },
      { title: "Real", content: "actual content" },
    ]);
    expect(out).not.toContain('"Empty"');
    expect(out).toContain('"Real"');
    expect(out).toContain("actual content");
  });
});
