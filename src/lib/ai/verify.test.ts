import { describe, expect, it, vi, beforeEach } from "vitest";

const state = { aiModel: "m", aiProvider: "openrouter", aiFallbackProvider: "none", aiFallbackModel: "" };
vi.mock("../../store", () => ({ useAppStore: { getState: () => state } }));
const aiComplete = vi.fn();
const hasApiKey = vi.fn();
vi.mock("./client", () => ({ aiComplete: (...a: unknown[]) => aiComplete(...a), hasApiKey: (...a: unknown[]) => hasApiKey(...a) }));

const { aiProblem } = await import("./verify");

beforeEach(() => {
  Object.assign(state, { aiModel: "m", aiProvider: "openrouter", aiFallbackProvider: "none", aiFallbackModel: "" });
  aiComplete.mockReset().mockResolvedValue("OK");
  hasApiKey.mockReset().mockResolvedValue(true);
});

describe("checking AI before it is switched on", () => {
  it("passes when the provider answers, even with nothing in so few tokens", async () => {
    expect(await aiProblem()).toBeNull();
    aiComplete.mockRejectedValue("empty|length");
    expect(await aiProblem()).toBeNull();
  });

  it("says what is wrong instead of switching on", async () => {
    aiComplete.mockRejectedValue("401|bad key");
    expect(await aiProblem()).toMatch(/API key is invalid/);
    hasApiKey.mockResolvedValue(false);
    expect(await aiProblem()).toMatch(/Add your API key/);
    state.aiModel = "";
    expect(await aiProblem()).toMatch(/Pick a model/);
  });

  it("needs no key for a local model", async () => {
    state.aiProvider = "local";
    hasApiKey.mockResolvedValue(false);
    expect(await aiProblem()).toBeNull();
  });

  it("sends no note text", async () => {
    await aiProblem();
    expect(aiComplete.mock.calls[0][0]).toEqual([{ role: "user", content: "Reply with OK." }]);
  });
});
