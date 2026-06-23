import { visit, SKIP } from "unist-util-visit";
import type { Root, Text, Link, PhrasingContent } from "mdast";

const WIKI_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Remark plugin: converts [[Note Title]] → <a href="note://Note%20Title">Note Title</a>.
 * MarkdownPreview intercepts note:// clicks to navigate to the matching tab.
 */
export function remarkWikiLinks() {
  return (tree: Root) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (!parent || index == null) return;

      WIKI_RE.lastIndex = 0;
      const parts: PhrasingContent[] = [];
      let lastIdx = 0;
      let match: RegExpExecArray | null;

      while ((match = WIKI_RE.exec(node.value)) !== null) {
        if (match.index > lastIdx) {
          parts.push({ type: "text", value: node.value.slice(lastIdx, match.index) });
        }
        const title = match[1].trim();
        parts.push({
          type:     "link",
          url:      `note://${encodeURIComponent(title)}`,
          title:    null,
          children: [{ type: "text", value: title }],
        } as Link);
        lastIdx = match.index + match[0].length;
      }

      if (parts.length === 0) return;

      if (lastIdx < node.value.length) {
        parts.push({ type: "text", value: node.value.slice(lastIdx) });
      }

      (parent.children as PhrasingContent[]).splice(index, 1, ...parts);
      // Tell visitor to skip the newly-inserted nodes and continue after them
      return [SKIP, index + parts.length] as [typeof SKIP, number];
    });
  };
}
