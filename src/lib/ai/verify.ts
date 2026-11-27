import { aiComplete, hasApiKey } from "./client";
import { mapAiError } from "./errors";
import { useAppStore } from "../../store";

/**
 * Whether AI would work right now, checked before it is switched on: a model, a key where one is needed, and a tiny
 * request that the provider (or the fallback) answers. Returns null, or what is wrong in words. Listing models is
 * not enough: some providers list them without any key. No note text is sent.
 */
export async function aiProblem(): Promise<string | null> {
  const s = useAppStore.getState();
  if (!s.aiModel) return "Pick a model first (Settings → AI).";
  const hasFallback = s.aiFallbackProvider !== "none" && !!s.aiFallbackModel;
  if (s.aiProvider !== "local" && !hasFallback && !(await hasApiKey(s.aiProvider))) {
    return "Add your API key in Settings → AI.";
  }
  try {
    await aiComplete([{ role: "user", content: "Reply with OK." }], { maxTokens: 5, temperature: 0, noRetry: true });
    return null;
  } catch (e) {
    // It answered, just with nothing in five tokens: the connection and the key work.
    if (String(e instanceof Error ? e.message : e).startsWith("empty|")) return null;
    return mapAiError(e);
  }
}
