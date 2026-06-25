import { describe, it, expect } from "vitest";
import { detectDiagramIntent } from "./prompts";

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
