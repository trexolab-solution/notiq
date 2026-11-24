import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ImageOff } from "lucide-react";

/** Only these go to the system's browser or mail app; anything else in a link (a script, a file path) is plain text. */
export const OPENABLE_LINK = /^(https?:\/\/|mailto:)/i;

const components: Components = {
  a: ({ href, children }) => {
    if (!href || !OPENABLE_LINK.test(href)) return <span>{children}</span>;
    return <a href={href} title={href} onClick={(e) => { e.preventDefault(); void openUrl(href).catch(() => {}); }}>{children}</a>;
  },
  // A file on a server can't be trusted to load pictures from the web (that tells whoever runs the address that it was
  // opened): pictures stay as their description. A picture inside the file itself (a data address) is shown.
  img: ({ src, alt }) => {
    if (typeof src === "string" && /^data:image\//i.test(src)) return <img src={src} alt={alt ?? ""} />;
    return (
      <span className="inline-flex items-center gap-1.5 rounded border border-[var(--color-border)] px-1.5 py-0.5 text-xs text-[var(--color-text-muted)]" title="Pictures from the web are not loaded">
        <ImageOff size={12} aria-hidden />{alt || "image"}
      </span>
    );
  },
};

/** The library drops every address it doesn't know, a picture inside the file (a data address) included: that one is kept. */
const urlTransform = (url: string, key: string) => (key === "src" && /^data:image\//i.test(url) ? url : defaultUrlTransform(url));

/**
 * A remote Markdown file as a page, with the look of the editor's preview: headings, lists, tables, task lists, code
 * with colours. Raw HTML in the file is not run; links open in the browser; web pictures are not loaded.
 */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="prose-scroll absolute inset-0" data-testid="markdown-view">
      <div className="prose-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]} components={components} urlTransform={urlTransform}>{text}</ReactMarkdown>
      </div>
    </div>
  );
}
