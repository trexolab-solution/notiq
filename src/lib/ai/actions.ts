import type * as monacoNs from "monaco-editor";
import { useAppStore } from "../../store";
import { aiComplete, aiCompleteStream, stripCodeFences, type ChatMessage, type CompleteOpts } from "./client";
import { mapAiError } from "./errors";
import { mermaidFenceAt, allMermaidFences, type MermaidFence } from "./context";
import { aiActivity } from "./activity";
import { validateMermaid } from "./mermaid";
import { showReview } from "./reviewEdit";
import { toast } from "../toast";
import * as P from "./prompts";

type Editor = monacoNs.editor.ICodeEditor;

const MAX_NOTE_CHARS = 8000; // keep requests inside free-tier-friendly sizes

/** Guard: AI on + model picked. Shows a hint toast otherwise. */
function ready(): boolean {
  const s = useAppStore.getState();
  if (!s.aiEnabled) { toast.warning("AI is off — turn it on in Settings → AI"); return false; }
  if (!s.aiModel) { toast.warning("Pick a model in Settings → AI"); return false; }
  return true;
}

async function withLoading<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const id = toast.info(`${label}…`, 120000);
  aiActivity.start();

  // Cancellation: a non-streaming request can't be aborted mid-HTTP from the
  // webview, but Esc should still stop the UX immediately — we race the request
  // against a cancel signal and ignore the late result. Same contract as streams.
  let cancelled = false;
  let onCancel: () => void = () => {};
  const cancelPromise = new Promise<never>((_, reject) => {
    onCancel = () => { cancelled = true; reject(new Error("cancelled")); };
  });
  const unregister = aiActivity.registerCanceler(onCancel);

  try {
    const r = await Promise.race([fn(), cancelPromise]);
    toast.dismiss(id);
    return r as T;
  } catch (e) {
    toast.dismiss(id);
    if (!cancelled) toast.error(mapAiError(e));
    return undefined;
  } finally {
    unregister();
    aiActivity.end();
  }
}

function selectionText(editor: Editor): { text: string; range: monacoNs.IRange } | null {
  const model = editor.getModel();
  const sel = editor.getSelection();
  if (!model || !sel || sel.isEmpty()) return null;
  return { text: model.getValueInRange(sel), range: sel };
}

/** Insert text at the cursor (or replace the selection if there is one). */
export function insertAtCursor(editor: Editor, text: string, source: string) {
  const sel = editor.getSelection();
  const pos = editor.getPosition();
  const range: monacoNs.IRange = sel
    ? sel
    : {
        startLineNumber: pos?.lineNumber ?? 1,
        startColumn: pos?.column ?? 1,
        endLineNumber: pos?.lineNumber ?? 1,
        endColumn: pos?.column ?? 1,
      };
  editor.executeEdits(source, [{ range, text, forceMoveMarkers: true }]);
  editor.focus();
}

interface StreamResult { text: string; startOffset: number; }

/**
 * Position `text` would END at if inserted starting at `start`. Computed from the
 * text's own line structure (NOT flat offsets), so it is correct regardless of
 * the model's EOL (\n vs \r\n) — fixes garbled multi-line streamed replacements.
 */
function endPositionAfter(start: monacoNs.IPosition, text: string): monacoNs.IPosition {
  const lines = text.split("\n");
  if (lines.length === 1) {
    return { lineNumber: start.lineNumber, column: start.column + lines[0].length };
  }
  return { lineNumber: start.lineNumber + lines.length - 1, column: lines[lines.length - 1].length + 1 };
}

/**
 * Stream a completion into the editor at `startOffset`, replacing `initialText`
 * (the originally-selected text) and then the growing output each tick. The span
 * is recomputed in (line, column) space from the previously-written string, so it
 * is duplication-safe and EOL-safe. Returns the final text + anchor, or null.
 */
async function streamReplace(
  editor: Editor,
  startOffset: number,
  initialText: string,
  messages: ChatMessage[],
  opts: CompleteOpts,
  source: string,
): Promise<StreamResult | null> {
  const model = editor.getModel();
  if (!model) return null;

  // Anchor start as a stable position — content before it never changes here.
  const startPos = model.getPositionAt(startOffset);
  let prev = initialText; // what currently occupies the span (original selection first)
  let written = "";
  let errored: unknown = null;
  let streaming = false;

  aiActivity.start();
  const apply = (full: string) => {
    const endPos = endPositionAfter(startPos, prev);
    editor.executeEdits(source, [{
      range: { startLineNumber: startPos.lineNumber, startColumn: startPos.column, endLineNumber: endPos.lineNumber, endColumn: endPos.column },
      text: full,
      forceMoveMarkers: true,
    }]);
    prev = full;
    written = full;
    // Keep the growing text in view.
    editor.revealPositionInCenterIfOutsideViewport(endPositionAfter(startPos, full));
  };

  const handle = aiCompleteStream(messages, opts, {
    onToken: (tok) => {
      // First token → switch from "thinking" shimmer to live text feedback.
      if (!streaming) { streaming = true; aiActivity.beginStream(); }
      apply(written + tok);
    },
  });
  const unregister = aiActivity.registerCanceler(handle.cancel);

  try {
    await handle.done;
  } catch (e) {
    errored = e;
  } finally {
    unregister();
    if (streaming) aiActivity.endStream();
    aiActivity.end();
  }

  if (errored) {
    if (written) apply(""); // roll back partial junk on hard error
    toast.error(mapAiError(errored));
    return null;
  }

  const clean = stripCodeFences(written);
  if (clean !== written) apply(clean);
  return { text: clean, startOffset };
}

/** Stream a fresh insertion at `startPos` (no initial text to replace). */
async function streamIntoEditor(
  editor: Editor,
  startPos: monacoNs.IPosition,
  messages: ChatMessage[],
  opts: CompleteOpts,
  source: string,
): Promise<string | null> {
  const model = editor.getModel();
  if (!model) return null;
  const res = await streamReplace(editor, model.getOffsetAt(startPos), "", messages, opts, source);
  if (res) editor.focus();
  return res ? res.text : null;
}

/**
 * Replace `range` with a streamed AI result, then offer an inline review
 * (Accept / Reject / Retry). Used by Improve, Fix grammar, and Ask-AI (replace).
 */
async function applyReplaceWithReview(
  editor: Editor,
  range: monacoNs.IRange,
  original: string,
  messages: ChatMessage[],
  opts: CompleteOpts,
  source: string,
): Promise<void> {
  const model = editor.getModel();
  if (!model) return;
  const startOffset = model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });

  const res = await streamReplace(editor, startOffset, original, messages, opts, source);
  if (!res) return;
  showReviewRetry(editor, res, original, messages, opts, source);
}

/** Show the review widget; Retry replaces the current result and re-shows it. */
function showReviewRetry(
  editor: Editor,
  res: StreamResult,
  original: string,
  messages: ChatMessage[],
  opts: CompleteOpts,
  source: string,
): void {
  showReview(editor, res.text, original, res.startOffset, {
    onRetry: () => {
      void (async () => {
        // The current result occupies the span now — replace IT (revert target stays `original`).
        const r2 = await streamReplace(editor, res.startOffset, res.text, messages, opts, source);
        if (r2) showReviewRetry(editor, r2, original, messages, opts, source);
      })();
    },
  });
}

// ── Continue writing (streamed) ─────────────────────────────────────────────────
export async function aiContinue(editor: Editor): Promise<void> {
  if (!ready()) return;
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return;
  const before = model
    .getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: pos.lineNumber, endColumn: pos.column })
    .slice(-MAX_NOTE_CHARS);

  const out = await streamIntoEditor(
    editor,
    pos,
    [{ role: "system", content: P.continueWritingSystem() }, { role: "user", content: before }],
    { maxTokens: 400, temperature: 0.5 },
    "ai-continue",
  );
  if (out) toast.success("Continued");
}

// ── Summarize (selection or whole note → appended summary) ─────────────────────
export async function aiSummarize(editor: Editor): Promise<void> {
  if (!ready()) return;
  const model = editor.getModel();
  if (!model) return;
  const sel = selectionText(editor);
  const source = (sel?.text ?? model.getValue()).slice(0, MAX_NOTE_CHARS);
  if (!source.trim()) { toast.warning("Nothing to summarize"); return; }

  const out = await withLoading("Summarizing", () =>
    aiComplete(
      [{ role: "system", content: P.summarizeSystem() }, { role: "user", content: source }],
      { maxTokens: 400, temperature: 0.3 },
    ),
  );
  if (!out) return;
  const summary = `\n\n## Summary\n\n${stripCodeFences(out).trim()}\n`;
  const end = model.getFullModelRange();
  editor.executeEdits("ai-summary", [
    { range: { startLineNumber: end.endLineNumber, startColumn: end.endColumn, endLineNumber: end.endLineNumber, endColumn: end.endColumn }, text: summary, forceMoveMarkers: true },
  ]);
  editor.focus();
  toast.success("Summary added");
}

// ── Custom instruction on a specific selection ──────────────────────────────────
//  • "replace": rewrite the selection in place.
//  • "append":  keep the selection and add the AI's answer/explanation below it.
export type CustomEditMode = "replace" | "append";

export async function aiCustomEdit(
  editor: Editor,
  range: monacoNs.IRange,
  instruction: string,
  mode: CustomEditMode = "replace",
): Promise<void> {
  if (!ready()) return;
  const model = editor.getModel();
  if (!model) return;
  const text = model.getValueInRange(range);
  if (!text.trim()) { toast.warning("Nothing selected to edit"); return; }
  if (!instruction.trim()) return;

  const system = mode === "append" ? P.customAppendSystem() : P.customEditSystem();
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `Instruction: ${instruction.trim()}\n\nText:\n${text.slice(0, MAX_NOTE_CHARS)}` },
  ];
  const opts = { maxTokens: Math.min(2000, Math.ceil(text.length / 2) + 300), temperature: 0.3 };

  if (mode === "append") {
    // Add a blank-line separator after the selection, then stream the answer in.
    const at: monacoNs.IRange = {
      startLineNumber: range.endLineNumber,
      startColumn: range.endColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
    };
    editor.executeEdits("ai-custom-append-sep", [{ range: at, text: `\n\n`, forceMoveMarkers: true }]);
    // Two newlines = two lines down; column 1 of the (now-empty) target line.
    // Line counting is EOL-independent, so this is correct on \n and \r\n files.
    const startPos = { lineNumber: range.endLineNumber + 2, column: 1 };
    const out = await streamIntoEditor(editor, startPos, messages, opts, "ai-custom-append");
    if (out) toast.success("Added below");
  } else {
    // Replace-in-place with a review step (accept / reject / retry).
    await applyReplaceWithReview(editor, range, text, messages, opts, "ai-custom-edit");
  }
}

// ── Improve / rewrite (selection → replace, streamed + review) ──────────────────
export async function aiImprove(editor: Editor): Promise<void> {
  if (!ready()) return;
  const sel = selectionText(editor);
  if (!sel || !sel.text.trim()) { toast.warning("Select some text to improve"); return; }
  const source = sel.text.slice(0, MAX_NOTE_CHARS);

  await applyReplaceWithReview(
    editor,
    sel.range,
    sel.text,
    [{ role: "system", content: P.improveSystem() }, { role: "user", content: source }],
    { maxTokens: Math.min(2000, Math.ceil(source.length / 2) + 200), temperature: 0.4 },
    "ai-improve",
  );
}

// ── Fix grammar (selection or whole note → replace, streamed + review) ──────────
export async function aiFixGrammar(editor: Editor): Promise<void> {
  if (!ready()) return;
  const model = editor.getModel();
  if (!model) return;
  const sel = selectionText(editor);
  const range: monacoNs.IRange = sel?.range ?? model.getFullModelRange();
  const original = sel?.text ?? model.getValue();
  const source = original.slice(0, MAX_NOTE_CHARS);
  if (!source.trim()) { toast.warning("Nothing to fix"); return; }

  await applyReplaceWithReview(
    editor,
    range,
    original,
    [{ role: "system", content: P.fixGrammarSystem() }, { role: "user", content: source }],
    { maxTokens: Math.min(2000, Math.ceil(source.length / 2) + 200), temperature: 0.1 },
    "ai-grammar",
  );
}

// ── Generate title → updates the active tab's title ────────────────────────────
export async function aiGenerateTitle(editor: Editor): Promise<void> {
  if (!ready()) return;
  const model = editor.getModel();
  if (!model) return;
  const content = model.getValue().slice(0, MAX_NOTE_CHARS);
  if (!content.trim()) { toast.warning("Note is empty"); return; }

  const out = await withLoading("Generating title", () =>
    aiComplete(
      [{ role: "system", content: P.generateTitleSystem() }, { role: "user", content }],
      { maxTokens: 30, temperature: 0.4 },
    ),
  );
  if (!out) return;
  const title = stripCodeFences(out).replace(/^["'#\s]+|["'\s]+$/g, "").split("\n")[0].slice(0, 80);
  const { activeTabId, updateTabTitle } = useAppStore.getState();
  if (title && activeTabId) {
    updateTabTitle(activeTabId, title);
    toast.success(`Title: ${title}`);
  }
}

// ── Fix Mermaid (validate with mermaid.parse, retry up to 3x) ───────────────────
export async function aiFixMermaid(editor: Editor): Promise<void> {
  if (!ready()) return;
  const model = editor.getModel();
  const pos = editor.getPosition();
  if (!model || !pos) return;

  // Resolve which mermaid block to fix, robustly:
  //  1) the block at the caret,
  //  2) the block at the selection start (right-click may not move the caret),
  //  3) if the note has exactly one mermaid block, use that.
  let fence: MermaidFence | null = mermaidFenceAt(model, pos);
  if (!fence) {
    const sel = editor.getSelection();
    if (sel) fence = mermaidFenceAt(model, { lineNumber: sel.startLineNumber, column: sel.startColumn });
  }
  if (!fence) {
    const all = allMermaidFences(model);
    if (all.length === 1) fence = all[0];
    else if (all.length > 1) { toast.warning("Click inside the mermaid block you want to fix"); return; }
  }
  if (!fence || !fence.code.trim()) {
    toast.warning("Put the cursor inside a ```mermaid block");
    return;
  }

  const initialErr = await validateMermaid(fence.code);
  if (!initialErr) {
    toast.info("This Mermaid diagram is already valid");
    return;
  }

  const fixed = await withLoading("Fixing Mermaid", async () => {
    let current = fence.code;
    let lastErr: string | null = initialErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = stripCodeFences(
        await aiComplete(
          [
            { role: "system", content: P.fixMermaidSystem() },
            { role: "user", content: `Mermaid code:\n${current}\n\nParser error:\n${lastErr}\n\nReturn corrected Mermaid only.` },
          ],
          { maxTokens: 600, temperature: 0.1 },
        ),
      );
      const verr = await validateMermaid(out);
      if (!verr) return out;
      current = out;
      lastErr = verr;
    }
    throw new Error("parse|Couldn't produce valid Mermaid after a few tries");
  });
  if (!fixed) return;

  const first = fence.startLine + 1;
  const last = Math.max(first, fence.endLine - 1);
  editor.executeEdits("ai-fix-mermaid", [
    {
      range: { startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: model.getLineMaxColumn(last) },
      text: fixed,
      forceMoveMarkers: true,
    },
  ]);
  editor.focus();
  toast.success("Mermaid fixed");
}
