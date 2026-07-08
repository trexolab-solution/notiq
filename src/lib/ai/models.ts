// Curated metadata for well-known Ollama models. NOTE: Ollama Cloud has no
// per-model free/paid gate — every model is reachable on every plan, funded by
// a single shared weekly usage quota (see ollama.com/pricing). What actually
// varies per model is how fast it burns that quota ("usage level" 1-4, light
// to extra-heavy) — we surface that instead, and rely on runtime error
// messages (errors.ts) for actual quota-exhaustion errors.

import type { AIProvider } from "../../types";

export type ModelKind = "code" | "chat" | "vision" | "embed";

export interface ModelMeta {
  kind: ModelKind;
  /** Short human note shown in the picker. */
  note?: string;
}

export const KNOWN_MODELS: Record<string, ModelMeta> = {
  "qwen3-coder:480b-cloud":   { kind: "code",   note: "Great for code & Mermaid" },
  "qwen3-coder":              { kind: "code",   note: "Code-focused" },
  "gpt-oss:120b-cloud":       { kind: "chat",   note: "Strong general model" },
  "gpt-oss:20b-cloud":        { kind: "chat",   note: "Lighter & faster" },
  "deepseek-v3.1:671b-cloud": { kind: "chat",   note: "Very large, high quality" },
  "qwen3-vl:235b-cloud":      { kind: "vision", note: "Understands images" },
  "llama3.1":                 { kind: "chat",   note: "General purpose" },
  "qwen2.5-coder":            { kind: "code",   note: "Code-focused (local)" },
  "nomic-embed-text":         { kind: "embed",  note: "Embeddings only" },
};

/** Best-effort metadata lookup (exact, then prefix/contains match). */
export function metaFor(id: string): ModelMeta {
  if (KNOWN_MODELS[id]) return KNOWN_MODELS[id];
  const lower = id.toLowerCase();
  for (const [key, meta] of Object.entries(KNOWN_MODELS)) {
    if (lower.startsWith(key.toLowerCase()) || lower.includes(key.toLowerCase())) return meta;
  }
  if (/coder|code/.test(lower)) return { kind: "code" };
  if (/(vl|vision|llava)/.test(lower)) return { kind: "vision" };
  if (/embed/.test(lower)) return { kind: "embed" };
  return { kind: "chat" };
}

/** Human-readable context window, e.g. 128000 → "128K ctx", 1000000 → "1M ctx". */
export function formatContextLength(n?: number): string | null {
  if (!n || n <= 0) return null;
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M ctx`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K ctx`;
  return `${n} ctx`;
}

/** A model actually billed against Ollama Cloud's shared quota — either fetched
 *  directly from the "cloud" provider, or a Local Ollama model proxied through
 *  your Ollama account (id ends in `-cloud`/`:cloud`, e.g. "gemma4:31b-cloud").
 *  The latter still spends the same cloud quota even though it's reached via
 *  the local endpoint, so it must NOT be flagged "Free" the way a real local
 *  model is. */
function isCloudBacked(id: string, provider?: AIProvider): boolean {
  if (provider === "openrouter") return false;
  return provider === "cloud" || /[-:]cloud$/i.test(id);
}

/** A cloud-backed model's id with any `-cloud`/`:cloud` suffix stripped, so a
 *  Local-proxied id (e.g. "gemma4:31b-cloud") and the Cloud provider's own id
 *  for the same model (e.g. "gemma4:31b") share one lookup key. */
function baseCloudId(id: string): string {
  return id.replace(/[-:]cloud$/i, "");
}

/** Real local models cost nothing (your own machine) — genuinely free.
 *  OpenRouter marks its free tier with a trailing `:free` on the id. Anything
 *  cloud-backed (see `isCloudBacked`) is never "free" — it spends shared
 *  quota — use `usageLevelFor` instead to show how much. */
export function isFreeModel(id: string, provider?: AIProvider): boolean {
  if (isCloudBacked(id, provider)) return false;
  if (provider === "local") return true;
  return /:free$/i.test(id);
}

export type UsageLevel = 1 | 2 | 3 | 4;

/**
 * Best-effort curated Ollama Cloud "usage level" (1 = light, 4 = extra-heavy) —
 * how fast a model burns the shared weekly quota. Ollama doesn't expose this
 * via any API; it's only shown per-model on ollama.com's own model pages, so
 * this list is necessarily incomplete and will drift as models are added or
 * re-tiered — uncatalogued models simply get no badge rather than a guess.
 * Keyed by the cloud id with any local `-cloud`/`:cloud` suffix stripped.
 */
const CLOUD_USAGE_LEVEL: Record<string, UsageLevel> = {
  "gpt-oss:20b": 1,
  "gpt-oss:120b": 2,
  "gemma4:31b": 2,
  "nemotron-3-super": 2,
  "qwen3-coder:480b": 2,
  "kimi-k2.5": 4,
  "kimi-k2.6": 4,
  "deepseek-v4-flash": 4,
  "deepseek-v4-pro": 4,
};

/** Usage level for a cloud-backed model (see `isCloudBacked`), or `null` when
 *  the model isn't cloud-backed or isn't in the curated list. */
export function usageLevelFor(id: string, provider?: AIProvider): UsageLevel | null {
  if (!isCloudBacked(id, provider)) return null;
  return CLOUD_USAGE_LEVEL[baseCloudId(id)] ?? null;
}

export function usageLevelLabel(level: UsageLevel): string {
  return `Lvl ${level}`;
}

/** Short hover explanation for the usage-level badge (the app's tooltip style
 *  is a single non-wrapping line, so keep this brief) — every Ollama Cloud
 *  plan can run every model, this just says how fast it drains your quota. */
export function usageLevelHelp(level: UsageLevel): string {
  const text: Record<UsageLevel, string> = {
    1: "Light — barely touches your Cloud weekly quota",
    2: "Standard — moderate Cloud quota usage",
    3: "Heavy — uses your Cloud quota quickly",
    4: "Extra-heavy — burns through your Cloud quota fast",
  };
  return text[level];
}

export function kindLabel(kind: ModelKind): string {
  switch (kind) {
    case "code":   return "Code";
    case "vision": return "Vision";
    case "embed":  return "Embed";
    default:        return "Chat";
  }
}
