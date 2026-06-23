import React, { useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { Tooltip } from "../ui/Tooltip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeHighlight from "rehype-highlight";
import rehypeSlug from "rehype-slug";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeKatex from "rehype-katex";
import type { Components } from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { useScrollSync } from "../../hooks/useScrollSync";
import { remarkWikiLinks } from "../../lib/remarkWikiLinks";
import { remarkAlerts } from "../../lib/remarkAlerts";
import { resolveNoteHref } from "../../lib/resolveNote";
import { dirname, isAbsolute, joinPath } from "../../lib/pathUtils";
import type { Tab } from "../../types";

// ── KaTeX CSS (loaded once) ────────────────────────────────────────────────────
import "katex/dist/katex.min.css";

// ── Sanitization schema ────────────────────────────────────────────────────────
// Extend the default GitHub schema to allow KaTeX classes, math attributes,
// style on certain elements, alert classes, and image protocols beyond http/https
// (the default would strip data:, blob:, and the Tauri asset:// scheme used on
// macOS/Linux, leaving <img> with no src).
const sanitizeSchema: typeof defaultSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    src: [
      ...(defaultSchema.protocols?.src ?? []),
      "data", "blob", "asset",
    ],
  },
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "mark", "abbr", "video", "audio", "figure", "figcaption",
    // KaTeX uses many custom elements — allow all math-related ones
    "math", "semantics", "mrow", "mi", "mo", "mn", "ms", "mtext",
    "annotation", "mfrac", "msup", "msub", "munder", "mover",
    "msqrt", "mroot", "mtable", "mtr", "mtd", "mspace", "mpadded",
    "menclose", "mglyph", "mlabeledtr", "mmultiscripts", "maction",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [
      ...(defaultSchema.attributes?.["*"] ?? []),
      "className", "dataAlert", "dataAlertTitle",
    ],
    div: [
      ...(defaultSchema.attributes?.["div"] ?? []),
      "className", "style",
    ],
    span: ["className", "style", "ariaHidden"],
    mark: [],
    abbr: ["title"],
    video: ["src", "controls", "autoPlay", "loop", "muted", "poster", "width", "height"],
    audio: ["src", "controls", "autoPlay", "loop", "muted"],
    source: ["src", "srcSet", "type"],
    img: [
      ...(defaultSchema.attributes?.["img"] ?? []),
      "width", "height", "loading",
    ],
    a: [
      ...(defaultSchema.attributes?.["a"] ?? []),
      "target", "rel",
    ],
    code: [
      ...(defaultSchema.attributes?.["code"] ?? []),
      "className",
    ],
    // KaTeX annotation
    annotation: ["encoding"],
    math: ["xmlns"],
  },
};

// ── Mermaid ───────────────────────────────────────────────────────────────────
let mermaidReady = false;
let mermaidInitPromise: Promise<void> | null = null;

async function ensureMermaid(): Promise<typeof import("mermaid")["default"]> {
  const m = (await import("mermaid")).default;
  if (!mermaidReady) {
    if (!mermaidInitPromise) {
      mermaidInitPromise = new Promise((resolve) => {
        m.initialize({
          startOnLoad: false, theme: "dark", securityLevel: "strict",
          fontFamily: "Inter, Segoe UI, system-ui, sans-serif", fontSize: 14,
        });
        mermaidReady = true;
        resolve();
      });
    }
    await mermaidInitPromise;
  }
  return m;
}

function MermaidBlock({ code }: { code: string }) {
  const ref   = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mmd-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    ensureMermaid().then(async (m) => {
      if (cancelled || !el) return;
      try {
        const { svg } = await m.render(idRef.current, code.trim());
        if (!cancelled && el) { el.textContent = ""; const parser = new DOMParser(); const doc = parser.parseFromString(svg, "image/svg+xml"); const svgEl = doc.documentElement; if (svgEl instanceof SVGElement) { el.appendChild(svgEl); } el.className = "mermaid-container"; }
      } catch (err) {
        if (!cancelled && el) {
          el.className = "";
          const errDiv = document.createElement("div");
          errDiv.className = "mermaid-error";
          errDiv.textContent = `Mermaid error: ${String(err)}`;
          el.textContent = "";
          el.appendChild(errDiv);
        }
      }
    });
    return () => { cancelled = true; };
  }, [code]);

  return <div ref={ref} className="mermaid-container" />;
}

// ── Code block with copy button + language badge ─────────────────────────────
function CodeBlock({
  node: _node,
  children,
  ...props
}: React.HTMLAttributes<HTMLPreElement> & { node?: unknown }) {
  const preRef            = useRef<HTMLPreElement>(null);
  const { copied, copy }  = useCopyToClipboard(2000);

  // Detect language from the nested <code> element's className
  const codeEl = React.Children.toArray(children).find(
    (c) => React.isValidElement(c) && c.type === "code",
  ) as React.ReactElement<{ className?: string }> | undefined;

  const langMatch = codeEl?.props?.className?.match(/language-(\w+)/);
  const lang = langMatch?.[1];

  return (
    <div className="code-block-wrapper">
      {lang && <span className="code-lang-badge">{lang}</span>}
      <pre ref={preRef} {...props}>{children}</pre>
      <Tooltip content="Copy code" disabled={copied}>
        <button
          className="code-copy-btn"
          onClick={() => {
            const text = preRef.current?.querySelector("code")?.innerText ?? "";
            copy(text);
          }}
        >
          {copied ? "\u2713 Copied" : "Copy"}
        </button>
      </Tooltip>
    </div>
  );
}

// ── Rehype plugin: convert local file paths in <img> to Tauri asset URLs ─────
// Must run BEFORE rehype-sanitize — sanitize treats "C:/…" as protocol "C:"
// and strips it. convertFileSrc produces https://asset.localhost/… which passes.
//
// Resolution order for each <img src>:
//   1. http(s):/data:/blob:/asset:  → leave as-is
//   2. tab.attachments[src]         → use mapped abs path (covers paste-image
//                                     temp attachments and just-saved relatives)
//   3. relative + tab.filePath      → resolve against note's parent dir
//   4. otherwise (absolute)         → existing convertFileSrc behavior
function makeRehypeLocalImages(activeTab: Tab | undefined) {
  return function rehypeLocalImages() {
    return (tree: { tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }) => {
      (function walk(node: { tagName?: string; properties?: Record<string, unknown>; children?: unknown[] }) {
        if (node.tagName === "img" && typeof node.properties?.src === "string") {
          const src = node.properties.src as string;
          if (
            !src.startsWith("http://") &&
            !src.startsWith("https://") &&
            !src.startsWith("data:") &&
            !src.startsWith("blob:") &&
            !src.startsWith("asset:")
          ) {
            const mapped = activeTab?.attachments?.[src];
            if (mapped) {
              try { node.properties.src = convertFileSrc(mapped); } catch { /* keep original */ }
            } else if (!isAbsolute(src) && activeTab?.filePath) {
              try {
                const abs = joinPath(dirname(activeTab.filePath), src);
                node.properties.src = convertFileSrc(abs);
              } catch { /* keep original */ }
            } else {
              try { node.properties.src = convertFileSrc(src); } catch { /* keep original */ }
            }
          }
        }
        if (node.children) (node.children as typeof node[]).forEach(walk);
      })(tree);
    };
  };
}

// ── Remark plugins (stable reference) ────────────────────────────────────────
const remarkPlugins = [remarkGfm, remarkWikiLinks, remarkMath, remarkAlerts];

// ── MarkdownPreview ───────────────────────────────────────────────────────────
interface MarkdownPreviewProps {
  content: string;
  onScrollChange?: (ratio: number) => void;
}

export interface PreviewHandle {
  scrollTo: (ratio: number) => void;
  /** The scrollable container element (for external search highlighting) */
  getContainerEl: () => HTMLElement | null;
}

export const MarkdownPreview = React.memo(
  React.forwardRef<PreviewHandle, MarkdownPreviewProps>(
    function MarkdownPreview({ content, onScrollChange }, ref) {
      const tabs             = useAppStore((s) => s.tabs);
      const activeTabId      = useAppStore((s) => s.activeTabId);
      const setActiveTab     = useAppStore((s) => s.setActiveTab);
      const updateTabContent = useAppStore((s) => s.updateTabContent);

      const activeTab = useMemo(
        () => tabs.find((t) => t.id === activeTabId),
        [tabs, activeTabId],
      );

      // Rehype plugin chain: must rebuild when active tab's attachments/filePath
      // change so rehypeLocalImages can resolve attachments map and relative paths.
      const rehypePlugins = useMemo(
        () => [
          rehypeRaw,
          makeRehypeLocalImages(activeTab),
          [rehypeSanitize, sanitizeSchema] as [typeof rehypeSanitize, typeof sanitizeSchema],
          rehypeHighlight,
          rehypeSlug,
          rehypeKatex,
        ],
        [activeTab?.attachments, activeTab?.filePath],
      );

      const scrollContainerRef = useRef<HTMLDivElement>(null);
      const { isSyncingRef, reportScroll } = useScrollSync(onScrollChange);

      // ── Imperative handle: let parent drive scroll position ───────────────
      useImperativeHandle(ref, () => ({
        scrollTo(ratio: number) {
          const el = scrollContainerRef.current;
          if (!el) return;
          const max = el.scrollHeight - el.clientHeight;
          if (max <= 0) return;
          isSyncingRef.current = true;
          el.scrollTop = ratio * max;
          setTimeout(() => { isSyncingRef.current = false; }, 50);
        },
        getContainerEl() {
          return scrollContainerRef.current;
        },
      }));

      // ── User scroll → report ratio ────────────────────────────────────────
      useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const onScroll = () => {
          if (isSyncingRef.current) return;
          const max = el.scrollHeight - el.clientHeight;
          if (max <= 0) return;
          reportScroll(el.scrollTop / max);
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
      }, [isSyncingRef, reportScroll]);

      // ── Checkbox toggle: finds the nth task item and flips its state ──────
      const handleCheckboxToggle = useCallback(
        (idx: number) => {
          const tab = tabs.find((t) => t.id === activeTabId);
          if (!tab) return;
          let count = -1;
          const newContent = tab.content.replace(
            /^(\s*[-*+] \[)([xX ])(])/gm,
            (match, before, state, after) => {
              count++;
              if (count === idx) return before + (state.trim() ? " " : "x") + after;
              return match;
            },
          );
          if (newContent !== tab.content) updateTabContent(activeTabId!, newContent);
        },
        [tabs, activeTabId, updateTabContent],
      );
      // Stable refs so memoized component closures never go stale
      const cbToggleRef = useRef(handleCheckboxToggle);
      cbToggleRef.current = handleCheckboxToggle;
      const tabsRef = useRef(tabs);
      tabsRef.current = tabs;
      const setActiveTabRef = useRef(setActiveTab);
      setActiveTabRef.current = setActiveTab;

      // Tracks which checkbox is being rendered; reset to 0 before each render pass
      const checkboxIdxRef = useRef(0);

      // ── Components ────────────────────────────────────────────────────────
      const components = useMemo<Components>(() => ({
        // ── Anchor: internal notes + fragment navigation + custom tooltips ──
        a({ href = "", children, ...props }) {
          const tabs         = tabsRef.current;
          const setActiveTab = setActiveTabRef.current;
          const decoded    = decodeURIComponent(href);
          const isExternal = /^https?:\/\//i.test(decoded);
          const isFragment = decoded.startsWith("#");
          const isWiki     = decoded.startsWith("note://");

          // Resolve the matching tab for internal links
          let noteTab: (typeof tabs)[number] | undefined;
          if (isWiki) {
            const title = decoded.slice(7);
            noteTab = tabs.find((t) => t.title.toLowerCase() === title.toLowerCase());
          } else if (!isExternal && !isFragment) {
            noteTab = resolveNoteHref(decoded, tabs);
          }

          const isNoteLink = isWiki || noteTab !== undefined;
          const noteExists  = isWiki
            ? tabs.some((t) => t.title.toLowerCase() === decoded.slice(7).toLowerCase())
            : !!noteTab;
          const noteTitle = isWiki
            ? decoded.slice(7)
            : (noteTab?.title ?? decoded.split("/").pop()?.replace(/\.md$/i, "") ?? decoded);

          const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
            e.preventDefault();

            if (isExternal) { openUrl(href).catch(console.error); return; }

            if (isFragment) {
              const id = decoded.slice(1);
              const el = scrollContainerRef.current ? document.getElementById(id) : null;
              if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
              return;
            }

            if (noteTab) { setActiveTab(noteTab.id); return; }
            if (isWiki) {
              const wikiTab = tabsRef.current.find(
                (t) => t.title.toLowerCase() === decoded.slice(7).toLowerCase(),
              );
              if (wikiTab) setActiveTabRef.current(wikiTab.id);
            }
          };

          // Internal note links — pill style with custom tooltip
          if (isNoteLink) {
            const tipText = noteExists ? `Open: ${noteTitle}` : `Note not found: ${noteTitle}`;
            return (
              <Tooltip content={tipText}>
                <a
                  {...props}
                  href={href}
                  onClick={handleClick}
                  className={`prose-note-link${noteExists ? "" : " missing"}`}
                >
                  {children}
                </a>
              </Tooltip>
            );
          }

          // External links — open in OS browser, custom tooltip with URL
          if (isExternal) {
            return (
              <Tooltip content={decoded} delay={400}>
                <a {...props} href={href} onClick={handleClick}>
                  {children}
                </a>
              </Tooltip>
            );
          }

          // Fragment / other links — no tooltip needed
          return (
            <a {...props} href={href} onClick={handleClick}>
              {children}
            </a>
          );
        },

        // ── Code blocks: stable module-level component with copy button ────
        pre: CodeBlock,

        // ── Inline code / Mermaid diagrams ────────────────────────────────
        code({ className, children, ...props }) {
          const match    = /language-(\w+)/.exec(className || "");
          const lang     = match?.[1];
          const codeText = String(children).replace(/\n$/, "");
          if (lang === "mermaid") return <MermaidBlock code={codeText} />;
          if (!className)         return <code {...props}>{children}</code>;
          return <code className={className} {...props}>{children}</code>;
        },

        // ── Task-list checkboxes: interactive, toggle the markdown source ──
        input({ type, checked, ...props }) {
          if (type !== "checkbox") return <input type={type} checked={checked} {...props} />;
          const idx = checkboxIdxRef.current++;
          return (
            <input
              type="checkbox"
              checked={checked ?? false}
              onChange={() => cbToggleRef.current(idx)}
              style={{ cursor: "pointer", accentColor: "var(--color-primary)" }}
            />
          );
        },

        // ── Abbreviation with custom tooltip ──────────────────────────────
        abbr({ title, children, ...props }) {
          if (!title) return <abbr {...props}>{children}</abbr>;
          return (
            <Tooltip content={title} delay={300}>
              <abbr {...props} style={{ cursor: "help", textDecoration: "underline dotted var(--color-text-muted)", textUnderlineOffset: "2px" }}>
                {children}
              </abbr>
            </Tooltip>
          );
        },

        // ── Style tags: stripped for security (CSS injection risk) ────────

        // ── Images with custom tooltip on alt text + lightbox click ───────
        img({ src, alt, ...props }) {
          const imgEl = (
            <img
              src={src}
              alt={alt ?? ""}
              loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.opacity = "0.4"; }}
              {...props}
            />
          );
          if (alt) {
            return (
              <Tooltip content={alt} delay={400}>
                {imgEl}
              </Tooltip>
            );
          }
          return imgEl;
        },
      }), []);

      // Reset checkbox counter before ReactMarkdown's synchronous render pass
      checkboxIdxRef.current = 0;

      return (
        <div ref={scrollContainerRef} className="prose-scroll">
          <div className="prose-body">
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={rehypePlugins}
              components={components}
            >
              {content || ""}
            </ReactMarkdown>
          </div>
        </div>
      );
    },
  ),
);
