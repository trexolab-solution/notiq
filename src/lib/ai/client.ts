import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../../store";
import { isTauri } from "../tauriWindow";
import { CURSOR_MARKER } from "./prompts";
import type { AIProvider } from "../../types";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteOpts {
  maxTokens?: number;
  temperature?: number;
  model?: string;
  baseUrl?: string;
}

export const CLOUD_BASE = "https://ollama.com/v1";
export const LOCAL_BASE = "http://localhost:11434/v1";

export function baseUrlFor(provider: AIProvider): string {
  return provider === "local" ? LOCAL_BASE : CLOUD_BASE;
}

export function currentBaseUrl(): string {
  return baseUrlFor(useAppStore.getState().aiProvider);
}

/** Run a chat completion via the Rust backend. Throws "no-model" if unset. */
export async function aiComplete(messages: ChatMessage[], opts: CompleteOpts = {}): Promise<string> {
  const s = useAppStore.getState();
  const model = opts.model ?? s.aiModel;
  if (!model) throw new Error("no-model");
  return invoke<string>("ai_complete", {
    baseUrl: opts.baseUrl ?? baseUrlFor(s.aiProvider),
    model,
    messages,
    maxTokens: opts.maxTokens ?? 256,
    temperature: opts.temperature ?? 0.2,
  });
}

export interface StreamHandle {
  /** Resolves when the stream finishes (or rejects on error). */
  done: Promise<void>;
  /** Stop receiving tokens. The backend request may still finish in the background. */
  cancel: () => void;
}

interface StreamCallbacks {
  onToken: (token: string) => void;
  /** Called once when the stream finishes. `finishReason` is "length" when the
   *  response was cut off by the token cap, "stop" on a clean finish, etc. */
  onComplete?: (finishReason?: string) => void;
}

/**
 * Streaming chat completion via the Rust backend. Returns a handle whose `done`
 * promise settles on completion/error, and a `cancel()` that detaches the token
 * listener so no further tokens are delivered.
 */
export function aiCompleteStream(
  messages: ChatMessage[],
  opts: CompleteOpts,
  { onToken, onComplete }: StreamCallbacks,
): StreamHandle {
  const s = useAppStore.getState();
  const model = opts.model ?? s.aiModel;

  let cancelled = false;
  let unlisten: (() => void) | null = null;
  let resolveDone: (() => void) | null = null;

  const cancel = () => {
    cancelled = true;
    if (unlisten) { unlisten(); unlisten = null; }
    // Settle the promise so awaiting callers (and their finally cleanup) proceed.
    resolveDone?.();
    resolveDone = null;
  };

  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    if (!model) { reject(new Error("no-model")); return; }
    const requestId = crypto.randomUUID();

    const unlistenPromise = listen<{ request_id: string; token: string; is_final: boolean; finish_reason?: string }>(
      "ai-stream-token",
      (event) => {
        if (cancelled || event.payload.request_id !== requestId) return;
        if (event.payload.is_final) {
          onComplete?.(event.payload.finish_reason);
          cancel();
          resolve();
        } else {
          onToken(event.payload.token);
        }
      },
    );
    unlistenPromise.then((un) => {
      if (cancelled) un(); // cancelled before the listener attached
      else unlisten = un;
    });

    invoke("ai_complete_stream", {
      requestId,
      baseUrl: opts.baseUrl ?? baseUrlFor(s.aiProvider),
      model,
      messages,
      maxTokens: opts.maxTokens ?? 256,
      temperature: opts.temperature ?? 0.2,
    }).catch((err) => {
      if (cancelled) return; // user cancelled — swallow
      cancel();
      reject(err);
    });
  });

  return { done, cancel };
}

/** List models from the provider's OpenAI-compatible /models endpoint. */
export async function aiListModels(baseUrl?: string): Promise<string[]> {
  return invoke<string[]>("ai_list_models", { baseUrl: baseUrl ?? currentBaseUrl() });
}

export async function setApiKey(key: string): Promise<void> {
  await invoke("set_ai_api_key", { key });
}

export async function hasApiKey(): Promise<boolean> {
  if (!isTauri) return false;
  return invoke<boolean>("has_ai_api_key").catch(() => false);
}

export async function clearApiKey(): Promise<void> {
  await invoke("clear_ai_api_key");
}

/** Strip a leading ```lang fence and trailing ``` from a model's output. */
export function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```[a-zA-Z0-9-]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

export interface CleanOpts {
  /** Continue on the current line — strip any leading line break(s). */
  sameLine?: boolean;
  /** Keep only the first line (for inserts in the middle of a line). */
  singleLine?: boolean;
  /** Force the completion onto a new line — prepend a line break if missing. */
  newLine?: boolean;
}

/**
 * Clean an inline-autocomplete completion: drop the cursor marker, unwrap a
 * stray code fence, trim text echoed from the surrounding context, and apply
 * line-awareness (same-line continuation vs. new line). Preserves a meaningful
 * leading space (for mid-word/sentence continuation).
 */
export function cleanCompletion(raw: string, prefix: string, suffix: string, opts: CleanOpts = {}): string {
  let out = raw.split(CURSOR_MARKER).join("");
  out = out.replace(/^\s*```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");

  if (opts.sameLine) {
    // Continue the current line: drop a leading newline + the indentation after it.
    out = out.replace(/^[\r\n]+[ \t]*/, "");
  } else {
    // New paragraph allowed, but never more than one blank line.
    out = out.replace(/^\n{3,}/, "\n\n");
  }

  if (opts.singleLine) {
    out = out.split(/\r?\n/)[0];
  }

  out = trimStartOverlap(out, prefix);
  out = trimEndOverlap(out, suffix);
  out = trimSuffixOverlapLines(out, suffix);
  out = out.replace(/[ \t\r\n]+$/, "");

  // Force a new line when the cursor context demands it (heading body / next list item).
  if (opts.newLine && out && !out.startsWith("\n")) out = "\n" + out;
  return out;
}

/**
 * Normalize a model's diagram output into exactly one ```mermaid fenced block.
 * Handles: a proper ```mermaid block, a generic ``` block, or raw mermaid code.
 */
export function ensureMermaidBlock(raw: string): string {
  let out = raw.split(CURSOR_MARKER).join("").trim();
  const fenced = out.match(/```mermaid[\s\S]*?```/i);
  if (fenced) return fenced[0].trim();
  // Strip any stray outer fence, then wrap the inner code.
  const inner = out.replace(/^```[\w-]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  return "```mermaid\n" + inner + "\n```";
}

/** Remove the leading part of `text` that duplicates the tail of `prefix`. */
function trimStartOverlap(text: string, prefix: string): string {
  const max = Math.min(prefix.length, 120);
  for (let len = max; len >= 4; len--) {
    if (text.startsWith(prefix.slice(-len))) return text.slice(len);
  }
  return text;
}

/** Remove the trailing part of `text` that duplicates the head of `suffix`. */
function trimEndOverlap(text: string, suffix: string): string {
  const head = suffix.replace(/^\s+/, "");
  const max = Math.min(head.length, 120);
  for (let len = max; len >= 4; len--) {
    if (text.endsWith(head.slice(0, len))) return text.slice(0, text.length - len);
  }
  return text;
}

/**
 * Line-based, whitespace-tolerant dedup: drop trailing completion lines that
 * already exist as the leading lines of the suffix. Fixes the classic
 * "extra closing brackets/tags" duplication in code and structured text.
 */
function trimSuffixOverlapLines(text: string, suffix: string): string {
  if (!text.includes("\n") && !suffix.trim()) return text;
  const tLines = text.split("\n");
  const sLines = suffix.split("\n");
  let s = 0;
  while (s < sLines.length && sLines[s].trim() === "") s++; // skip blank suffix lines
  const sContent = sLines.slice(s);

  const maxK = Math.min(tLines.length, sContent.length);
  for (let k = maxK; k >= 1; k--) {
    let match = true;
    let hasContent = false;
    for (let i = 0; i < k; i++) {
      const tl = tLines[tLines.length - k + i].trim();
      const sl = sContent[i].trim();
      if (tl !== sl) { match = false; break; }
      if (tl !== "") hasContent = true;
    }
    if (match && hasContent) return tLines.slice(0, tLines.length - k).join("\n");
  }
  return text;
}
