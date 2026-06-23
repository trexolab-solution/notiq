import type * as monacoNs from "monaco-editor";
import { useAppStore } from "../../store";
import { aiComplete, cleanCompletion, ensureMermaidBlock, stripCodeFences } from "./client";
import { buildAutocompleteMessages, buildDiagramMessages, detectDiagramIntent, fixMermaidSystem } from "./prompts";
import { buildContext, lineMode } from "./context";
import { aiActivity } from "./activity";
import { validateMermaid } from "./mermaid";

let registered = false;

/**
 * Register the AI inline-completions (ghost-text) provider exactly once for the
 * given monaco instance. Reads live settings on each request, so it is a no-op
 * (zero network) whenever AI or autocomplete is disabled.
 */
export function ensureInlineProvider(monaco: typeof monacoNs): void {
  if (registered) return;
  registered = true;

  const provider: monacoNs.languages.InlineCompletionsProvider = {
    async provideInlineCompletions(model, position, context, token) {
      const s = useAppStore.getState();
      const empty = { items: [] };
      if (!s.aiEnabled || !s.aiAutocompleteEnabled || !s.aiModel) return empty;

      const isExplicit =
        context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit;
      if (s.aiTriggerMode === "manual" && !isExplicit) return empty;

      // Debounce automatic triggers; bail if Monaco cancels (user kept typing).
      if (!isExplicit) {
        const debounceMs = Number.isFinite(s.aiDebounceMs) ? Math.max(0, s.aiDebounceMs) : 400;
        const cancelled = await sleepCancellable(debounceMs, token);
        if (cancelled || token.isCancellationRequested) return empty;
      }

      const ctx = buildContext(model, position, s.aiContextLines);
      if (!ctx.prefix.trim() && !ctx.suffix.trim()) return empty;

      // Note title gives the model topic awareness for better continuations.
      const activeTab = useAppStore.getState().tabs.find((t) => t.id === useAppStore.getState().activeTabId);
      const noteTitle = activeTab && activeTab.title !== "Untitled" ? activeTab.title : undefined;

      // ── Diagram intent: user asked for a visual/chart → emit a whole ```mermaid
      // block (the app renders Mermaid, so we always answer in Mermaid). Detected
      // from the last non-empty line when the cursor is at a line boundary.
      const intentLine = lastNonEmptyLine(ctx.prefix);
      const diagramMode =
        !ctx.inMermaid && !ctx.fenceLang &&
        (ctx.atLineEnd || ctx.atLineStart) &&
        detectDiagramIntent(intentLine);

      let insertText: string;

      if (diagramMode) {
        const { system, user } = buildDiagramMessages(ctx.prefix.slice(-2000), noteTitle);
        let block: string | null = null;
        try {
          block = await trackCancellable(token, async () => {
            const raw = await aiComplete(
              [{ role: "system", content: system }, { role: "user", content: user }],
              { maxTokens: 700, temperature: 0.2 },
            );
            let b = ensureMermaidBlock(raw);
            // Validate; on a parse error, do one repair pass so we never insert a
            // diagram that renders an error box.
            const err = await validateMermaid(stripCodeFences(b));
            if (err) {
              const fixRaw = await aiComplete(
                [
                  { role: "system", content: fixMermaidSystem() },
                  { role: "user", content: `Mermaid code:\n${stripCodeFences(b)}\n\nParser error:\n${err}\n\nReturn corrected Mermaid only (no fences).` },
                ],
                { maxTokens: 700, temperature: 0.1 },
              );
              b = ensureMermaidBlock(fixRaw);
            }
            return b;
          });
        } catch { block = null; }
        if (block == null || token.isCancellationRequested) return empty;
        // Separate the block from preceding text with a blank line when needed.
        const lead = ctx.lineBefore.trim() !== "" ? "\n\n" : "";
        insertText = lead + block;
      } else {
        // Structural mode decides exactly how the completion should join the text.
        const mode = lineMode(ctx);
        const { system, user } = buildAutocompleteMessages({ ...ctx, noteTitle, mode });

        const flags =
          mode === "inline"        ? { sameLine: true, singleLine: true } :
          mode === "continue"      ? { sameLine: true } :
          mode === "heading-body"  ? { newLine: true } :
          mode === "list-item"     ? { newLine: true } :
          /* fresh */                {};
        const maxTokens =
          mode === "inline" ? 60 : mode === "list-item" ? 80 : mode === "continue" ? 120 : 160;

        let out: string | null = null;
        try {
          out = await trackCancellable(token, () =>
            aiComplete([{ role: "system", content: system }, { role: "user", content: user }],
              { maxTokens, temperature: ctx.fenceLang || ctx.inMermaid ? 0.15 : 0.3 }),
          );
        } catch { out = null; }
        if (out == null || token.isCancellationRequested) return empty;

        insertText = cleanCompletion(out, ctx.prefix, ctx.suffix, flags);
      }

      if (!insertText) return empty;

      return {
        items: [
          {
            insertText,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column,
            ),
          },
        ],
      };
    },
    disposeInlineCompletions() {
      /* nothing to dispose */
    },
  };

  // Register for ALL languages ("*") so autocomplete works in any file open in
  // the editor (code files, configs, etc.), not just markdown/plaintext notes.
  // The provider already adapts its prompt to the language / code-fence context.
  monaco.languages.registerInlineCompletionsProvider("*", provider);
}

/** The last line in `text` that has non-whitespace content (or ""). */
function lastNonEmptyLine(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== "") return lines[i];
  }
  return "";
}

/**
 * Like `aiActivity.track`, but ends the activity the instant Monaco cancels the
 * request (the user kept typing). The busy indicator clears immediately and the
 * superseded suggestion is abandoned — the professional "type-to-cancel" feel.
 * The underlying HTTP call may still run to completion in the background; its
 * result is discarded by the `token.isCancellationRequested` checks at the call
 * sites, so it never reaches the editor.
 */
function trackCancellable<T>(token: monacoNs.CancellationToken, fn: () => Promise<T>): Promise<T> {
  aiActivity.start();
  let ended = false;
  const endOnce = () => { if (!ended) { ended = true; aiActivity.end(); } };
  const sub = token.onCancellationRequested(endOnce);
  return fn().finally(() => { sub.dispose(); endOnce(); });
}

/** Resolves false after `ms`, or true immediately if the token is cancelled. */
function sleepCancellable(ms: number, token: monacoNs.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(false);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
