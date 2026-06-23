// Curated metadata for well-known Ollama models. NOTE: Ollama Cloud uses a
// global free tier with daily limits rather than a reliable per-model free/paid
// flag, so we surface capability + size badges here and rely on runtime error
// messages (errors.ts) for credit/quota issues — we do NOT hardcode pricing.

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

/** Suggested defaults to seed the picker before/while the live list loads. */
export const SUGGESTED_CLOUD_MODELS = [
  "qwen3-coder:480b-cloud",
  "gpt-oss:120b-cloud",
  "gpt-oss:20b-cloud",
];

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

export function kindLabel(kind: ModelKind): string {
  switch (kind) {
    case "code":   return "Code";
    case "vision": return "Vision";
    case "embed":  return "Embed";
    default:        return "Chat";
  }
}
