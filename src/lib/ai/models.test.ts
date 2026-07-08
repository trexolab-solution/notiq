import { describe, it, expect } from "vitest";
import { isFreeModel, formatContextLength, kindLabel, metaFor, usageLevelFor, usageLevelLabel, usageLevelHelp } from "./models";

describe("isFreeModel", () => {
  it("treats a real local model (no cloud suffix) as free", () => {
    expect(isFreeModel("qwen2.5:7b", "local")).toBe(true);
    expect(isFreeModel("anything-at-all", "local")).toBe(true);
  });

  it("treats an OpenRouter id ending in :free as free", () => {
    expect(isFreeModel("meta-llama/llama-3.3-70b-instruct:free", "openrouter")).toBe(true);
    expect(isFreeModel("google/gemma-4-31b-it:free")).toBe(true); // provider optional
  });

  it("does not mark a plain OpenRouter id as free", () => {
    expect(isFreeModel("openai/gpt-4o", "openrouter")).toBe(false);
  });

  it("never marks a cloud-provider model as free — no per-model gate, it spends shared quota", () => {
    expect(isFreeModel("qwen3-coder:480b", "cloud")).toBe(false);
    expect(isFreeModel("something:free", "cloud")).toBe(false); // cloud-backed always wins over the :free convention
  });

  it("does not mark a Local model proxied through Ollama Cloud as free (still spends the shared quota)", () => {
    expect(isFreeModel("gemma4:31b-cloud", "local")).toBe(false);
    expect(isFreeModel("kimi-k2.6:cloud", "local")).toBe(false);
  });
});

describe("usageLevelFor", () => {
  it("returns a curated level for a known Cloud-provider model", () => {
    expect(usageLevelFor("gpt-oss:20b", "cloud")).toBe(1);
    expect(usageLevelFor("deepseek-v4-pro", "cloud")).toBe(4);
  });

  it("matches the same level for the equivalent Local-proxied cloud suffix id", () => {
    expect(usageLevelFor("gpt-oss:20b-cloud", "local")).toBe(1);
    expect(usageLevelFor("kimi-k2.6:cloud", "local")).toBe(4);
  });

  it("returns null for an uncatalogued cloud model (no guessing)", () => {
    expect(usageLevelFor("some-brand-new-model", "cloud")).toBeNull();
  });

  it("returns null for a real local model and for OpenRouter", () => {
    expect(usageLevelFor("qwen2.5:7b", "local")).toBeNull();
    expect(usageLevelFor("openai/gpt-4o", "openrouter")).toBeNull();
  });
});

describe("usageLevelLabel", () => {
  it("formats as Lvl N", () => {
    expect(usageLevelLabel(1)).toBe("Lvl 1");
    expect(usageLevelLabel(4)).toBe("Lvl 4");
  });
});

describe("usageLevelHelp", () => {
  it("gives a distinct short explanation per level", () => {
    const texts = ([1, 2, 3, 4] as const).map(usageLevelHelp);
    expect(new Set(texts).size).toBe(4); // all four are distinct
    expect(usageLevelHelp(1)).toMatch(/light/i);
    expect(usageLevelHelp(4)).toMatch(/extra-heavy/i);
  });
});

describe("formatContextLength", () => {
  it("formats thousands and millions", () => {
    expect(formatContextLength(33000)).toBe("33K ctx");
    expect(formatContextLength(1_000_000)).toBe("1M ctx");
    expect(formatContextLength(262144)).toBe("262K ctx");
  });

  it("returns null for missing/zero values", () => {
    expect(formatContextLength(undefined)).toBeNull();
    expect(formatContextLength(0)).toBeNull();
  });
});

describe("metaFor / kindLabel", () => {
  it("recognizes known coder models", () => {
    expect(kindLabel(metaFor("qwen2.5-coder").kind)).toBe("Code");
  });

  it("falls back to Chat for unknown ids", () => {
    expect(kindLabel(metaFor("some-random-model-id").kind)).toBe("Chat");
  });
});
