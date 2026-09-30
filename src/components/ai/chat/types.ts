import type { AIProvider } from "../../../types";

/** A single chat turn. */
export interface Msg {
  role: "user" | "assistant";
  content: string;
  /** A short system note about this reply (fallback switch, length cutoff) —
   *  rendered as a separate banner, never mixed into `content` so Copy/Insert
   *  only ever carry what the model actually said. */
  note?: string;
  noteTone?: "info" | "warning";
}

export const MAX_NOTE_CHARS = 8000;
/** Combined ceiling across every selected context file, split proportionally. */
export const MAX_TOTAL_CONTEXT_CHARS = 20000;
export const PROVIDER_TAG: Record<AIProvider, string> = { cloud: "Cloud", local: "Local", openrouter: "OpenRouter" };
export const DEFAULT_MODEL_VALUE = "__default__";
