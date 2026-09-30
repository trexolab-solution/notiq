import React from "react";
import { Check, Copy, CornerDownLeft, FilePlus2 } from "lucide-react";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { toast } from "../../../lib/toast";
import { Tooltip } from "../../ui/Tooltip";

/**
 * Wraps a fenced code block (already syntax-highlighted by rehype-highlight) with
 * a header bar: language label + Copy + Insert-into-note. `children` is the
 * highlighted <code> element from react-markdown; `code` is its plain text.
 */
export function CodeBlock({ code, lang, onInsert, onNewFile, children }: {
  code: string; lang: string;
  onInsert: (c: string) => void;
  onNewFile: (c: string, lang: string) => void;
  children: React.ReactNode;
}) {
  const { copied, copy } = useCopyToClipboard(1500);
  const doCopy = () => {
    copy(code).then((ok) => { if (!ok) toast.error("Couldn't copy"); });
  };
  return (
    <div className="ai-code">
      <div className="ai-code__head">
        <span className="ai-code__lang">{lang || "code"}</span>
        <div className="ai-code__actions">
          <Tooltip content={copied ? "Copied" : "Copy code"}>
            <button className="ai-code__btn" aria-label="Copy code" onClick={doCopy}>
              {copied ? <Check size={12} /> : <Copy size={12} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </Tooltip>
          <Tooltip content="Open this code as a new file/tab">
            <button className="ai-code__btn" aria-label="Open code as new file" onClick={() => onNewFile(code, lang)}>
              <FilePlus2 size={12} /><span>New file</span>
            </button>
          </Tooltip>
          <Tooltip content="Insert this code into the active note">
            <button className="ai-code__btn" aria-label="Insert code into note" onClick={() => onInsert(code)}>
              <CornerDownLeft size={12} /><span>Insert</span>
            </button>
          </Tooltip>
        </div>
      </div>
      <pre className="ai-code__pre">{children}</pre>
    </div>
  );
}
