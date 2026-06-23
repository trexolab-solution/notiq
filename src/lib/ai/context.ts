import type * as monacoNs from "monaco-editor";

export type LineKind =
  | "heading" | "list" | "task" | "ordered-list" | "table" | "blockquote" | "code" | "text";

export interface CompletionContext {
  prefix: string;
  suffix: string;
  inMermaid: boolean;
  /** Language of the enclosing ``` fence (excluding mermaid), if any. */
  fenceLang: string | null;
  /** What kind of line the cursor is on — guides the model's output format. */
  lineKind: LineKind;
  /** Text on the current line before the cursor. */
  lineBefore: string;
  /** Text on the current line after the cursor. */
  lineAfter: string;
  /** Nothing meaningful before the cursor on this line (empty/whitespace). */
  atLineStart: boolean;
  /** Nothing meaningful after the cursor on this line (empty/whitespace). */
  atLineEnd: boolean;
}

/** Build trimmed prefix/suffix + structural hints around the cursor. */
export function buildContext(
  model: monacoNs.editor.ITextModel,
  position: monacoNs.IPosition,
  contextLines: number,
): CompletionContext {
  const lineCount = model.getLineCount();
  const startLine = Math.max(1, position.lineNumber - contextLines);
  // Balanced window: as much context below the cursor as above, so the model
  // sees existing closing brackets/lines and never duplicates them.
  const endLine = Math.min(lineCount, position.lineNumber + contextLines);

  const prefix = model.getValueInRange({
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const suffix = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: endLine,
    endColumn: model.getLineMaxColumn(endLine),
  });

  const fence = enclosingFence(model, position);
  const inMermaid = fence?.lang === "mermaid";
  const curLine = model.getLineContent(position.lineNumber);
  const lineBefore = curLine.slice(0, position.column - 1);
  const lineAfter = curLine.slice(position.column - 1);

  return {
    prefix,
    suffix,
    inMermaid,
    fenceLang: fence && !inMermaid ? (fence.lang || null) : null,
    lineKind: detectLineKind(curLine, !!fence),
    lineBefore,
    lineAfter,
    atLineStart: lineBefore.trim() === "",
    atLineEnd: lineAfter.trim() === "",
  };
}

/**
 * What the completion at the cursor should structurally do:
 *  - inline       : middle of a line → fill on the same line, single line.
 *  - continue     : end of an unfinished line/sentence → continue same line.
 *  - heading-body : end of a heading → body text on a NEW line.
 *  - list-item    : end of a complete list item → next item on a NEW line.
 *  - fresh        : empty line or finished sentence → new sentence/paragraph.
 */
export type LineMode = "inline" | "continue" | "heading-body" | "list-item" | "fresh";

/** A line is "unfinished" when it doesn't end with sentence/clause punctuation. */
function isUnfinished(lineBefore: string): boolean {
  const t = lineBefore.trimEnd();
  if (t === "") return false;
  return !/[.!?:][)"'\]]?$/.test(t);
}

export function lineMode(ctx: CompletionContext): LineMode {
  if (ctx.lineAfter.trim() !== "") return "inline";   // text after cursor on this line
  if (ctx.atLineStart) return "fresh";                // empty line
  const unfinished = isUnfinished(ctx.lineBefore);
  if (ctx.lineKind === "heading") return "heading-body";
  if (ctx.lineKind === "list" || ctx.lineKind === "task" || ctx.lineKind === "ordered-list") {
    return unfinished ? "continue" : "list-item";
  }
  return unfinished ? "continue" : "fresh";
}

/** Language of the ``` fence the cursor is inside (cursor must be past the opening line). */
function enclosingFence(
  model: monacoNs.editor.ITextModel,
  position: monacoNs.IPosition,
): { lang: string } | null {
  let inFence = false;
  let lang = "";
  let startLine = -1;
  for (let ln = 1; ln <= position.lineNumber; ln++) {
    const m = model.getLineContent(ln).trim().match(/^```+\s*([\w-]*)/);
    if (!m) continue;
    if (!inFence) { inFence = true; lang = (m[1] || "").toLowerCase(); startLine = ln; }
    else { inFence = false; lang = ""; startLine = -1; }
  }
  return inFence && position.lineNumber > startLine ? { lang } : null;
}

function detectLineKind(line: string, inFence: boolean): LineKind {
  if (inFence) return "code";
  if (/^\s*#{1,6}\s/.test(line)) return "heading";
  if (/^\s*[-*+]\s+\[[ xX]\]/.test(line)) return "task";
  if (/^\s*\d+\.\s/.test(line)) return "ordered-list";
  if (/^\s*[-*+]\s/.test(line)) return "list";
  if (/^\s*>/.test(line)) return "blockquote";
  if (line.includes("|")) return "table";
  return "text";
}

export interface MermaidFence {
  /** 1-based line of the opening ``` fence. */
  startLine: number;
  /** 1-based line of the closing ``` fence (or lineCount+1 if unclosed at EOF). */
  endLine: number;
  /** The code between the fences. */
  code: string;
}

/**
 * If the cursor sits inside a ```` ```mermaid ```` fenced block, return that
 * block's range + code. Scans fences from the top, skipping non-mermaid blocks.
 */
export function mermaidFenceAt(
  model: monacoNs.editor.ITextModel,
  position: monacoNs.IPosition,
): MermaidFence | null {
  const total = model.getLineCount();
  let inMermaid = false;
  let fenceStart = -1;

  for (let ln = 1; ln <= total; ln++) {
    const text = model.getLineContent(ln).trim();
    if (!/^```/.test(text)) continue;

    if (!inMermaid) {
      if (/^```\s*mermaid\b/i.test(text)) {
        inMermaid = true;
        fenceStart = ln;
      } else {
        // Some other code fence — skip to its closing fence.
        let j = ln + 1;
        while (j <= total && !/^```/.test(model.getLineContent(j).trim())) j++;
        ln = j; // for-loop ++ moves past the closing fence
      }
    } else {
      // Closing mermaid fence at line `ln`.
      if (position.lineNumber > fenceStart && position.lineNumber <= ln) {
        return { startLine: fenceStart, endLine: ln, code: codeBetween(model, fenceStart, ln) };
      }
      inMermaid = false;
      fenceStart = -1;
    }
  }

  // Unclosed mermaid block running to EOF, cursor inside it.
  if (inMermaid && position.lineNumber > fenceStart) {
    return { startLine: fenceStart, endLine: total + 1, code: codeBetween(model, fenceStart, total + 1) };
  }
  return null;
}

/** All ```` ```mermaid ```` blocks in the document. */
export function allMermaidFences(model: monacoNs.editor.ITextModel): MermaidFence[] {
  const total = model.getLineCount();
  const fences: MermaidFence[] = [];
  let inMermaid = false;
  let fenceStart = -1;

  for (let ln = 1; ln <= total; ln++) {
    const text = model.getLineContent(ln).trim();
    if (!/^```/.test(text)) continue;

    if (!inMermaid) {
      if (/^```\s*mermaid\b/i.test(text)) {
        inMermaid = true;
        fenceStart = ln;
      } else {
        let j = ln + 1;
        while (j <= total && !/^```/.test(model.getLineContent(j).trim())) j++;
        ln = j;
      }
    } else {
      fences.push({ startLine: fenceStart, endLine: ln, code: codeBetween(model, fenceStart, ln) });
      inMermaid = false;
      fenceStart = -1;
    }
  }
  if (inMermaid) {
    fences.push({ startLine: fenceStart, endLine: total + 1, code: codeBetween(model, fenceStart, total + 1) });
  }
  return fences;
}

function codeBetween(
  model: monacoNs.editor.ITextModel,
  fenceStart: number,
  fenceEnd: number,
): string {
  const first = fenceStart + 1;
  const last = fenceEnd - 1;
  if (last < first) return "";
  return model.getValueInRange({
    startLineNumber: first,
    startColumn: 1,
    endLineNumber: last,
    endColumn: model.getLineMaxColumn(last),
  });
}
