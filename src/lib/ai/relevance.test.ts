import { describe, it, expect } from "vitest";
import { scoreRelevance, relevanceLabel } from "./relevance";

describe("scoreRelevance", () => {
  it("is low when the message or note is empty", () => {
    expect(scoreRelevance("", "some note content")).toBe("low");
    expect(scoreRelevance("hello there", "")).toBe("low");
  });

  it("is high when the message refers to the document explicitly", () => {
    expect(scoreRelevance("fix this code", "function foo() {}")).toBe("high");
  });

  it("is high on strong keyword overlap", () => {
    expect(scoreRelevance("alpha beta gamma", "alpha beta gamma delta")).toBe("high");
  });

  it("is medium on partial overlap without referential phrasing", () => {
    expect(
      scoreRelevance("alpha beta gamma delta epsilon zeta", "alpha beta"),
    ).toBe("medium");
  });

  it("is low when nothing overlaps and nothing is referential", () => {
    expect(
      scoreRelevance("totally unrelated gibberish zzz", "apple banana cherry"),
    ).toBe("low");
  });
});

describe("relevanceLabel", () => {
  it("maps buckets to human labels", () => {
    expect(relevanceLabel("high")).toBe("Relevant");
    expect(relevanceLabel("medium")).toBe("Loosely related");
    expect(relevanceLabel("low")).toBe("Probably unrelated");
  });
});
