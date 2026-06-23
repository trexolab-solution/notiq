import { visit } from "unist-util-visit";
import type { Root, Blockquote, Html } from "mdast";

/**
 * GitHub-style alert/admonition syntax:
 *
 *   > [!NOTE]
 *   > Useful information that users should know.
 *
 * Supported types: NOTE, TIP, IMPORTANT, WARNING, CAUTION
 *
 * Converts to:
 *   <div class="markdown-alert markdown-alert-note">
 *     <p class="markdown-alert-title">Note</p>
 *     <p>Useful information...</p>
 *   </div>
 */

const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

const ALERT_ICONS: Record<string, string> = {
  note:      "\u2139\uFE0F",
  tip:       "\uD83D\uDCA1",
  important: "\u2757",
  warning:   "\u26A0\uFE0F",
  caution:   "\uD83D\uDED1",
};

export function remarkAlerts() {
  return (tree: Root) => {
    visit(tree, "blockquote", (node: Blockquote, index, parent) => {
      if (!parent || index == null) return;

      // The first child must be a paragraph whose first child is text matching the alert pattern
      const firstChild = node.children[0];
      if (!firstChild || firstChild.type !== "paragraph") return;

      const firstInline = firstChild.children[0];
      if (!firstInline || firstInline.type !== "text") return;

      // Check first line of the text for [!TYPE]
      const lines = firstInline.value.split("\n");
      const match = ALERT_RE.exec(lines[0]);
      if (!match) return;

      const alertType = match[1].toLowerCase();
      const icon = ALERT_ICONS[alertType] ?? "";
      const label = alertType.charAt(0).toUpperCase() + alertType.slice(1);

      // Remove the [!TYPE] line from the first text node
      const remainingLines = lines.slice(1);
      if (remainingLines.length > 0) {
        firstInline.value = remainingLines.join("\n");
      } else {
        // Remove the empty first text node; if paragraph becomes empty, remove it
        firstChild.children.shift();
        if (firstChild.children.length === 0) {
          node.children.shift();
        }
      }

      // Build the HTML wrapper using raw HTML nodes
      const titleHtml: Html = {
        type: "html",
        value: `<div class="markdown-alert markdown-alert-${alertType}"><p class="markdown-alert-title">${icon} ${label}</p>`,
      };
      const closeHtml: Html = {
        type: "html",
        value: "</div>",
      };

      // Replace the blockquote with the alert wrapper containing the remaining content
      const newChildren = [titleHtml, ...node.children, closeHtml];
      parent.children.splice(index, 1, ...(newChildren as typeof parent.children));

      // Skip past the inserted nodes
      return index + newChildren.length;
    });
  };
}
