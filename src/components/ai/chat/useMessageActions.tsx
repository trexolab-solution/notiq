import React, { useCallback, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { useAppStore } from "../../../store";
import { getActiveEditor } from "../../../lib/activeEditor";
import { insertAtCursor } from "../../../lib/ai/actions";
import { resolveCodeLang } from "../../../lib/ai/codeLang";
import { toast } from "../../../lib/toast";
import { CodeBlock } from "./CodeBlock";

/** Flatten a React node tree to its plain-text content (for copying code). */
function nodeText(node: React.ReactNode): string {
  if (node == null || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (React.isValidElement(node)) return nodeText((node.props as { children?: React.ReactNode }).children);
  return "";
}

/**
 * Per-message actions: copy-to-clipboard (tracked by message index), insert
 * into the active note, and the markdown `pre` renderer that gives every
 * fenced code block a CodeBlock header (lang + Copy + New file + Insert).
 */
export function useMessageActions() {
  const insertToNote = useCallback((content: string) => {
    const ed = getActiveEditor();
    if (!ed) { toast.warning("Open a note first"); return; }
    insertAtCursor(ed, content, "ai-chat-insert");
    toast.success("Inserted into note");
  }, []);

  // Open a code block as a new unsaved tab in the right language.
  const newFileFromCode = useCallback((code: string, fenceLang: string) => {
    const { lang, ext } = resolveCodeLang(fenceLang, code);
    useAppStore.getState().addTab({
      title: `snippet.${ext}`,
      content: code,
      language: lang,
      editorMode: "markdown", // source view (no md preview for code)
    });
    toast.success(`Opened as snippet.${ext}`);
  }, []);

  // Custom markdown renderers: fenced code blocks get a header (lang + Copy + New file + Insert).
  const mdComponents = useMemo<Components>(() => ({
    pre({ children }) {
      // The single child is the <code> element produced by react-markdown.
      const child = Array.isArray(children) ? children[0] : children;
      const props = React.isValidElement(child)
        ? (child.props as { className?: string; children?: React.ReactNode })
        : undefined;
      const className: string = props?.className ?? "";
      const m = /language-(\w+)/.exec(className);
      const lang = m ? m[1] : "";
      const code = nodeText(props?.children).replace(/\n$/, "");
      return <CodeBlock code={code} lang={lang} onInsert={insertToNote} onNewFile={newFileFromCode}>{child}</CodeBlock>;
    },
  }), [insertToNote, newFileFromCode]);

  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const copyMsg = useCallback((content: string, idx: number) => {
    writeText(content)
      .then(() => {
        setCopiedIdx(idx);
        setTimeout(() => setCopiedIdx((c) => (c === idx ? null : c)), 1500);
      })
      .catch(() => toast.error("Couldn't copy"));
  }, []);

  return { mdComponents, copiedIdx, copyMsg, insertToNote };
}
