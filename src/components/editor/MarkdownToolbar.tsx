import React, { useRef, useState, useCallback } from "react";
import * as monaco from "monaco-editor";
import {
  Bold, Italic, Strikethrough, Code,
  Heading1, Heading2, Heading3,
  Link2, Image as ImageIcon, FolderOpen,
  List, ListOrdered, CheckSquare,
  Quote, Code2, Minus, Table, Wand2,
  WrapText, Hash, Search, ZoomIn, ZoomOut,
  Link as LinkIcon,
} from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { useClickOutside } from "../../hooks/useClickOutside";
import { Tooltip } from "../ui/Tooltip";
import { formatDocument } from "../../lib/formatter";
import { toast } from "../../lib/toast";
import { useAppStore } from "../../store";

// ─── Types ────────────────────────────────────────────────────────────────────

export type FormatAction =
  | "h1" | "h2" | "h3"
  | "bold" | "italic" | "strikethrough" | "code"
  | "link" | "image"
  | "ul" | "ol" | "task"
  | "blockquote" | "codeblock" | "hr" | "table";

type IEditor = monaco.editor.IStandaloneCodeEditor;
type IEdit   = monaco.editor.IIdentifiedSingleEditOperation;

// ─── Format helpers ───────────────────────────────────────────────────────────

function wrapInline(
  ed: IEditor,
  sel: monaco.Selection,
  text: string,
  marker: string,
  placeholder = "text",
) {
  const already =
    text.length >= marker.length * 2 + 1 &&
    text.startsWith(marker) &&
    text.endsWith(marker);

  if (already) {
    ed.executeEdits("md", [{ range: sel, text: text.slice(marker.length, text.length - marker.length) }]);
  } else {
    const inner = text || placeholder;
    ed.executeEdits("md", [{ range: sel, text: `${marker}${inner}${marker}` }]);
    if (!text) {
      const s  = sel.getStartPosition();
      const ml = marker.length;
      ed.setSelection(new monaco.Selection(
        s.lineNumber, s.column + ml,
        s.lineNumber, s.column + ml + placeholder.length,
      ));
    }
  }
  ed.focus();
}

function applyHeading(ed: IEditor, level: number) {
  const model = ed.getModel();
  const sel   = ed.getSelection();
  if (!model || !sel) return;

  const prefix = "#".repeat(level) + " ";
  const edits: IEdit[] = [];

  for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
    const line = model.getLineContent(ln);
    const m    = line.match(/^(#{1,6}) /);
    let next: string;
    if (m && m[1].length === level) next = line.slice(level + 1);
    else if (m)                      next = prefix + line.slice(m[0].length);
    else                             next = prefix + line;
    edits.push({ range: new monaco.Range(ln, 1, ln, line.length + 1), text: next });
  }
  ed.executeEdits("md", edits);
  ed.focus();
}

function applyLinePrefix(ed: IEditor, prefix: string) {
  const model = ed.getModel();
  const sel   = ed.getSelection();
  if (!model || !sel) return;

  let allHave = true;
  for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
    if (!model.getLineContent(ln).startsWith(prefix)) { allHave = false; break; }
  }

  const edits: IEdit[] = [];
  for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
    const line = model.getLineContent(ln);
    edits.push({
      range: new monaco.Range(ln, 1, ln, line.length + 1),
      text:  allHave ? line.slice(prefix.length) : prefix + line,
    });
  }
  ed.executeEdits("md", edits);
  ed.focus();
}

function applyOl(ed: IEditor) {
  const model = ed.getModel();
  const sel   = ed.getSelection();
  if (!model || !sel) return;

  const re = /^\d+\.\s/;
  let allHave = true;
  for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
    if (!re.test(model.getLineContent(ln))) { allHave = false; break; }
  }

  const edits: IEdit[] = [];
  let i = 1;
  for (let ln = sel.startLineNumber; ln <= sel.endLineNumber; ln++) {
    const line = model.getLineContent(ln);
    edits.push({
      range: new monaco.Range(ln, 1, ln, line.length + 1),
      text:  allHave ? line.replace(re, "") : `${i++}. ${line}`,
    });
  }
  ed.executeEdits("md", edits);
  ed.focus();
}

// ─── Public formatting API ────────────────────────────────────────────────────

export function applyFormat(ed: IEditor, action: FormatAction) {
  const model = ed.getModel();
  const sel   = ed.getSelection();
  if (!model || !sel) return;

  const text = model.getValueInRange(sel);

  switch (action) {
    case "h1": return applyHeading(ed, 1);
    case "h2": return applyHeading(ed, 2);
    case "h3": return applyHeading(ed, 3);

    case "bold":          return wrapInline(ed, sel, text, "**");
    case "italic":        return wrapInline(ed, sel, text, "*");
    case "strikethrough": return wrapInline(ed, sel, text, "~~");
    case "code":          return wrapInline(ed, sel, text, "`", "code");

    case "ul":         return applyLinePrefix(ed, "- ");
    case "ol":         return applyOl(ed);
    case "task":       return applyLinePrefix(ed, "- [ ] ");
    case "blockquote": return applyLinePrefix(ed, "> ");

    case "link": {
      const inner = text || "text";
      ed.executeEdits("md", [{ range: sel, text: `[${inner}](url)` }]);
      const s = sel.getStartPosition();
      const start = s.column + inner.length + 3;
      ed.setSelection(new monaco.Selection(s.lineNumber, start, s.lineNumber, start + 3));
      ed.focus();
      break;
    }

    case "image": {
      const alt = text || "alt";
      ed.executeEdits("md", [{ range: sel, text: `![${alt}](url)` }]);
      const s = sel.getStartPosition();
      const start = s.column + alt.length + 4;
      ed.setSelection(new monaco.Selection(s.lineNumber, start, s.lineNumber, start + 3));
      ed.focus();
      break;
    }

    case "codeblock": {
      const inner = text || "code";
      const s = sel.getStartPosition();
      ed.executeEdits("md", [{ range: sel, text: `\`\`\`language\n${inner}\n\`\`\`` }]);
      // Select "language" so the user can immediately type the language name
      ed.setSelection(new monaco.Selection(
        s.lineNumber, s.column + 3,
        s.lineNumber, s.column + 3 + "language".length,
      ));
      ed.focus();
      break;
    }

    case "hr": {
      const ln  = sel.endLineNumber;
      const len = model.getLineContent(ln).length;
      ed.executeEdits("md", [{ range: new monaco.Range(ln, len + 1, ln, len + 1), text: "\n\n---\n" }]);
      ed.focus();
      break;
    }

    case "table": {
      ed.executeEdits("md", [{
        range: sel,
        text: "| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n",
      }]);
      ed.focus();
      break;
    }
  }
}

// ─── Browse image & insert ────────────────────────────────────────────────────

async function browseAndInsertImage(ed: IEditor) {
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (!selected || Array.isArray(selected)) return;

  const model = ed.getModel();
  const sel = ed.getSelection();
  if (!model || !sel) return;

  const alt = model.getValueInRange(sel) || "image";
  const filePath = selected.replace(/\\/g, "/");
  ed.executeEdits("md", [{ range: sel, text: `![${alt}](${filePath})` }]);
  ed.focus();
}

// ─── Active-format detection ──────────────────────────────────────────────────
// Inspects the model at the given cursor position and returns the set of
// FormatActions that are "on" there — used to highlight toolbar buttons.

export function detectActiveFormats(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
): Set<FormatAction> {
  const active = new Set<FormatAction>();
  const { lineNumber, column } = position;
  const line = model.getLineContent(lineNumber);
  const pos  = column - 1; // convert to 0-indexed for string operations

  // ── Block-level (line-prefix checks) ─────────────────────────────────────
  const headingM = line.match(/^(#{1,6}) /);
  if (headingM) {
    const lvl = headingM[1].length;
    if (lvl === 1) active.add("h1");
    if (lvl === 2) active.add("h2");
    if (lvl === 3) active.add("h3");
  }

  if (/^> /.test(line))              active.add("blockquote");
  if (/^[-*+] \[[ xX]\] /.test(line)) active.add("task");
  else if (/^[-*+] /.test(line))     active.add("ul");
  if (/^\d+\. /.test(line))          active.add("ol");

  // ── Fenced code block ─────────────────────────────────────────────────────
  // Count opening ``` fences above the cursor line.
  let fences = 0;
  for (let ln = 1; ln < lineNumber; ln++) {
    if (/^`{3,}/.test(model.getLineContent(ln))) fences++;
  }
  if (fences % 2 === 1) {
    active.add("codeblock");
    return active; // inside a fence — inline marks don't apply
  }

  // ── Inline marks ─────────────────────────────────────────────────────────
  // Helper: check if 0-indexed `pos` is strictly inside a regex match's span.
  const inside = (m: RegExpMatchArray) =>
    m.index !== undefined && pos > m.index && pos < m.index + m[0].length;

  // Bold: **text**
  for (const m of line.matchAll(/\*\*(.+?)\*\*/g)) {
    if (inside(m)) { active.add("bold"); break; }
  }

  // Italic: *text* — mask out bold spans first so ** doesn't confuse the match
  const noBold = line.replace(/\*\*(.+?)\*\*/g, (s) => " ".repeat(s.length));
  for (const m of noBold.matchAll(/\*(.+?)\*/g)) {
    if (inside(m)) { active.add("italic"); break; }
  }

  // Strikethrough: ~~text~~
  for (const m of line.matchAll(/~~(.+?)~~/g)) {
    if (inside(m)) { active.add("strikethrough"); break; }
  }

  // Inline code: `code`
  for (const m of line.matchAll(/`([^`]+)`/g)) {
    if (inside(m)) { active.add("code"); break; }
  }

  // Link: [text](url)  — exclude image prefix
  for (const m of line.matchAll(/(?<!\!)\[([^\]]*)\]\([^)]*\)/g)) {
    if (inside(m)) { active.add("link"); break; }
  }

  // Image: ![alt](url)
  for (const m of line.matchAll(/!\[([^\]]*)\]\([^)]*\)/g)) {
    if (inside(m)) { active.add("image"); break; }
  }

  return active;
}

// ─── Toolbar component ────────────────────────────────────────────────────────

function TBtn({ title, onClick, active, children }: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  // Parse "Label  (Shortcut)" → { label, shortcut }
  const m        = title.match(/^(.*?)\s{1,2}\(([^)]+)\)\s*$/);
  const label    = m ? m[1].trim() : title;
  const shortcut = m ? m[2] : undefined;

  return (
    <Tooltip content={label} shortcut={shortcut}>
      <button
        type="button"
        // onMouseDown + preventDefault keeps Monaco focused when a button is clicked
        onMouseDown={(e) => { e.preventDefault(); onClick(); }}
        className={`md-toolbar-btn${active ? " is-active" : ""}`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Sep() {
  return <span className="md-toolbar-sep" />;
}

/** Image button with a dropdown: "From URL" or "Browse file" */
function ImageButton({ editorRef, active }: { editorRef: { current: IEditor | null }; active: boolean }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useClickOutside(wrapRef, () => setOpen(false), open);

  const handleUrl = useCallback(() => {
    setOpen(false);
    const ed = editorRef.current;
    if (ed) applyFormat(ed, "image");
  }, [editorRef]);

  const handleBrowse = useCallback(async () => {
    setOpen(false);
    const ed = editorRef.current;
    if (ed) await browseAndInsertImage(ed);
  }, [editorRef]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <Tooltip content="Image">
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); setOpen((v) => !v); }}
          className={`md-toolbar-btn${active ? " is-active" : ""}`}
        >
          <ImageIcon size={13} />
        </button>
      </Tooltip>
      {open && (
        <div className="md-toolbar-dropdown">
          <button
            className="md-toolbar-dropdown-item"
            onMouseDown={(e) => { e.preventDefault(); handleUrl(); }}
          >
            <LinkIcon size={12} />
            <span>From URL</span>
          </button>
          <button
            className="md-toolbar-dropdown-item"
            onMouseDown={(e) => { e.preventDefault(); handleBrowse(); }}
          >
            <FolderOpen size={12} />
            <span>Browse Image</span>
          </button>
        </div>
      )}
    </div>
  );
}

interface MarkdownToolbarProps {
  editorRef:     { current: IEditor | null };
  activeFormats: Set<FormatAction>;
  /** When true the Format button is shown (non-markdown files only) */
  showFormat?:   boolean;
  /** When true the Markdown formatting buttons are shown (md / memory notes only) */
  showMarkdownTools?: boolean;
}

export function MarkdownToolbar({ editorRef, activeFormats, showFormat, showMarkdownTools = true }: MarkdownToolbarProps) {
  const [formatting, setFormatting] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const wordWrap           = useAppStore((s) => s.wordWrap);
  const setWordWrap        = useAppStore((s) => s.setWordWrap);
  const showLineNumbers    = useAppStore((s) => s.showLineNumbers);
  const setShowLineNumbers = useAppStore((s) => s.setShowLineNumbers);
  const editorFontSize     = useAppStore((s) => s.editorFontSize);
  const setEditorFontSize  = useAppStore((s) => s.setEditorFontSize);

  const handleFormat = async () => {
    const ed = editorRef.current;
    if (!ed || formatting) return;
    setFormatting(true);
    const result = await formatDocument(ed);
    setFormatting(false);
    if (result.ok) toast.success("Document formatted");
    else           toast.error(`Format failed: ${result.message}`);
  };

  const act = (a: FormatAction) => {
    const ed = editorRef.current;
    if (ed) applyFormat(ed, a);
  };
  const on = (a: FormatAction) => activeFormats.has(a);

  return (
    <div className="md-toolbar" role="toolbar" aria-label="Markdown formatting">
      {/* Markdown formatting tools — only meaningful for md / memory notes */}
      {showMarkdownTools && (
        <>
          {/* Headings */}
          <TBtn title="Heading 1  (Ctrl+Alt+1)" active={on("h1")} onClick={() => act("h1")}><Heading1 size={13} /></TBtn>
          <TBtn title="Heading 2  (Ctrl+Alt+2)" active={on("h2")} onClick={() => act("h2")}><Heading2 size={13} /></TBtn>
          <TBtn title="Heading 3  (Ctrl+Alt+3)" active={on("h3")} onClick={() => act("h3")}><Heading3 size={13} /></TBtn>

          <Sep />

          {/* Inline formatting */}
          <TBtn title="Bold  (Ctrl+B)"                active={on("bold")}          onClick={() => act("bold")}><Bold size={13} /></TBtn>
          <TBtn title="Italic  (Ctrl+I)"              active={on("italic")}        onClick={() => act("italic")}><Italic size={13} /></TBtn>
          <TBtn title="Strikethrough  (Ctrl+Shift+X)" active={on("strikethrough")} onClick={() => act("strikethrough")}><Strikethrough size={13} /></TBtn>
          <TBtn title="Inline code  (Ctrl+E)"         active={on("code")}          onClick={() => act("code")}><Code size={13} /></TBtn>

          <Sep />

          {/* Links / media */}
          <TBtn title="Link  (Ctrl+K)" active={on("link")}  onClick={() => act("link")}><Link2 size={13} /></TBtn>
          <ImageButton editorRef={editorRef} active={on("image")} />

          <Sep />

          {/* Lists */}
          <TBtn title="Bullet list  (Ctrl+Shift+8)"  active={on("ul")}   onClick={() => act("ul")}><List size={13} /></TBtn>
          <TBtn title="Ordered list  (Ctrl+Shift+7)" active={on("ol")}   onClick={() => act("ol")}><ListOrdered size={13} /></TBtn>
          <TBtn title="Task list  (Ctrl+Shift+9)"    active={on("task")} onClick={() => act("task")}><CheckSquare size={13} /></TBtn>

          <Sep />

          {/* Block elements */}
          <TBtn title="Blockquote  (Ctrl+Shift+.)" active={on("blockquote")} onClick={() => act("blockquote")}><Quote size={13} /></TBtn>
          <TBtn title="Code block  (Ctrl+Alt+C)"   active={on("codeblock")}  onClick={() => act("codeblock")}><Code2 size={13} /></TBtn>
          <TBtn title="Horizontal rule"                                       onClick={() => act("hr")}><Minus size={13} /></TBtn>
          <TBtn title="Table"                                                 onClick={() => act("table")}><Table size={13} /></TBtn>
        </>
      )}

      {/* Format button */}
      {showFormat && (
        <>
          <Sep />
          <Tooltip content="Format document" shortcut="Shift+Alt+F">
            <button
              ref={btnRef}
              className="md-toolbar-format-btn"
              disabled={formatting}
              onMouseDown={(e) => { e.preventDefault(); handleFormat(); }}
              aria-label="Format document"
            >
              <Wand2 size={11} strokeWidth={2} />
              {formatting ? "Formatting…" : "Format"}
            </button>
          </Tooltip>
        </>
      )}

      {/* ── Editor behaviour ──────────────────────────────────────── */}
      <Sep />

      <TBtn title="Word Wrap  (Alt+Z)" active={wordWrap} onClick={() => setWordWrap(!wordWrap)}>
        <WrapText size={13} />
      </TBtn>

      <TBtn title="Line Numbers" active={showLineNumbers} onClick={() => setShowLineNumbers(!showLineNumbers)}>
        <Hash size={13} />
      </TBtn>

      <TBtn title="Find  (Ctrl+F)" onClick={() => editorRef.current?.trigger("toolbar", "actions.find", null)}>
        <Search size={13} />
      </TBtn>

      <Sep />

      <TBtn title="Decrease font size" onClick={() => setEditorFontSize(Math.max(8, editorFontSize - 1))}>
        <ZoomOut size={13} />
      </TBtn>
      <span className="md-toolbar-fontsize">{editorFontSize}</span>
      <TBtn title="Increase font size" onClick={() => setEditorFontSize(Math.min(32, editorFontSize + 1))}>
        <ZoomIn size={13} />
      </TBtn>
    </div>
  );
}
