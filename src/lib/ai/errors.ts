// Maps backend AI errors to friendly, actionable messages.
// The Rust side returns "<status>|<body>", "network|...", or "parse|...".
// Frontend may also throw Error("no-model").

export function mapAiError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? "");
  if (msg === "no-model") return "Pick a model first (Settings → AI).";

  const sep = msg.indexOf("|");
  const head = sep === -1 ? msg : msg.slice(0, sep);
  const body = sep === -1 ? "" : msg.slice(sep + 1);

  if (head === "network") return "Couldn't reach the AI server — check your internet or that Ollama is running.";
  if (head === "parse") return "The AI response wasn't in the expected format.";

  switch (Number(head)) {
    case 401:
    case 403: return "API key is invalid or expired — update it in Settings → AI.";
    case 402: return "This model needs credits / a paid plan. Try a free model instead.";
    case 404: return "Model not found — refresh the model list or pick another.";
    case 429: return "Rate limit / quota reached — try again in a bit.";
    case 500:
    case 502:
    case 503: return "The AI server had an error — try again shortly.";
  }

  if (/quota|credit|insufficient|payment|billing/i.test(body)) {
    return "Out of credits / quota — try a free model or upgrade your plan.";
  }
  return body ? `AI error: ${body}` : `AI error: ${msg || "unknown"}`;
}
