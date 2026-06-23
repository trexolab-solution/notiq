import { marked } from "marked";
import type { Tokens } from "marked";
import { jsPDF } from "jspdf";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";

// ── Page geometry (A4 in mm) ──────────────────────────────────────────────────
const PW     = 210;
const PH     = 297;
const MX     = 18;               // horizontal margin
const MY     = 18;               // vertical margin
const CW     = PW - MX * 2;     // 174 mm content width

// pt → mm with leading multiplier
const ptMm = (pt: number, leading = 1.55) => pt * 0.3528 * leading;

// ── Strip inline markdown / HTML to plain text ────────────────────────────────
function strip(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g,  "")        // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")       // links
    .replace(/\*\*\*(.+?)\*\*\*/g,     "$1")       // bold-italic
    .replace(/___(.+?)___/g,           "$1")
    .replace(/\*\*(.+?)\*\*/g,         "$1")       // bold
    .replace(/__(.+?)__/g,             "$1")
    .replace(/\*(.+?)\*/g,             "$1")       // italic
    .replace(/_(.+?)_/g,               "$1")
    .replace(/~~(.+?)~~/g,             "$1")       // strike
    .replace(/`([^`]+)`/g,             "$1")       // inline code
    .replace(/<[^>]+>/g,               "")         // HTML tags
    .replace(/&amp;/g,  "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g,   ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'").replace(/&nbsp;/g, " ")
    .trim();
}

// ── PDF Builder ───────────────────────────────────────────────────────────────
class Builder {
  doc: jsPDF;
  y:   number;

  constructor() {
    this.doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    this.y   = MY;
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(11);
    this.doc.setTextColor(30, 41, 59);
  }

  // Adds a new page when `needed` mm won't fit on the current page
  private guard(needed: number) {
    if (this.y + needed > PH - MY) {
      this.doc.addPage();
      this.y = MY;
    }
  }

  private reset() {
    this.doc.setFont("helvetica", "normal");
    this.doc.setFontSize(11);
    this.doc.setTextColor(30, 41, 59);
    this.doc.setDrawColor(226, 232, 240);
    this.doc.setLineWidth(0.3);
  }

  heading(text: string, depth: number) {
    const sizes = [22, 17, 14, 12, 11, 11];
    const sz    = sizes[Math.min(depth - 1, 5)];
    const lh    = ptMm(sz, 1.35);

    this.guard(lh + 10);
    this.y += depth <= 3 ? 5 : 3;

    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(sz);
    this.doc.setTextColor(15, 23, 42);

    const lines = this.doc.splitTextToSize(strip(text), CW);
    this.doc.text(lines, MX, this.y);
    this.y += lines.length * lh;

    if (depth <= 2) {
      this.y += 1.5;
      this.doc.setDrawColor(226, 232, 240);
      this.doc.setLineWidth(0.35);
      this.doc.line(MX, this.y, PW - MX, this.y);
      this.y += 3.5;
    } else {
      this.y += 2;
    }

    this.reset();
  }

  paragraph(text: string) {
    const lh    = ptMm(11, 1.6);
    const lines = this.doc.splitTextToSize(strip(text), CW);
    this.guard(lines.length * lh);
    this.doc.text(lines, MX, this.y);
    this.y += lines.length * lh + 2;
    this.reset();
  }

  code(text: string) {
    const lh       = ptMm(9, 1.5);
    const rawLines = text.split("\n");
    const boxH     = rawLines.length * lh + 8;

    this.guard(boxH + 4);

    this.doc.setFillColor(248, 250, 252);
    this.doc.setDrawColor(226, 232, 240);
    this.doc.setLineWidth(0.3);
    this.doc.roundedRect(MX, this.y, CW, boxH, 1.5, 1.5, "FD");

    this.doc.setFont("courier", "normal");
    this.doc.setFontSize(9);
    this.doc.setTextColor(30, 41, 59);

    let cy = this.y + 5;
    for (const line of rawLines) {
      const wrapped = this.doc.splitTextToSize(line || " ", CW - 8);
      this.doc.text(wrapped, MX + 4, cy);
      cy += wrapped.length * lh;
    }
    this.y += boxH + 3;
    this.reset();
  }

  blockquote(text: string) {
    const lh    = ptMm(10.5, 1.6);
    this.doc.setFont("helvetica", "italic");
    this.doc.setFontSize(10.5);
    this.doc.setTextColor(100, 116, 139);

    const lines = this.doc.splitTextToSize(strip(text), CW - 8);
    const boxH  = lines.length * lh + 4;
    this.guard(boxH + 4);

    // accent bar
    this.doc.setFillColor(201, 168, 76);
    this.doc.rect(MX, this.y - 1, 1.5, boxH, "F");
    // tinted background
    this.doc.setFillColor(255, 251, 235);
    this.doc.rect(MX + 1.5, this.y - 1, CW - 1.5, boxH, "F");

    this.doc.text(lines, MX + 5, this.y);
    this.y += boxH + 3;
    this.reset();
  }

  list(token: Tokens.List, depth = 0) {
    const lh     = ptMm(11, 1.5);
    const indent = depth * 6;

    token.items.forEach((item, i) => {
      const bullet = token.ordered
        ? `${(typeof token.start === "number" ? token.start : 1) + i}.`
        : item.task ? (item.checked ? "[x]" : "[ ]") : "•";

      const maxW  = CW - indent - 7;
      const lines = this.doc.splitTextToSize(strip(item.text) || " ", maxW);
      this.guard(lines.length * lh + 2);

      this.doc.setFont("helvetica", "normal");
      this.doc.setFontSize(11);
      this.doc.setTextColor(30, 41, 59);

      this.doc.text(bullet, MX + indent, this.y);
      this.doc.text(lines, MX + indent + 7, this.y);
      this.y += lines.length * lh + 1;

      // nested lists
      for (const t of (item.tokens ?? [])) {
        if (t.type === "list") this.list(t as Tokens.List, depth + 1);
      }
    });

    if (depth === 0) this.y += 2;
    this.reset();
  }

  table(token: Tokens.Table) {
    const cols   = token.header.length;
    const colW   = CW / cols;
    const rowH   = 7;
    const totalH = (token.rows.length + 1) * rowH + 2;

    this.guard(totalH + 4);

    // header background
    this.doc.setFillColor(241, 245, 249);
    this.doc.rect(MX, this.y - 4.5, CW, rowH, "F");

    this.doc.setFont("helvetica", "bold");
    this.doc.setFontSize(10);
    this.doc.setTextColor(30, 41, 59);

    token.header.forEach((cell, ci) => {
      const t = this.doc.splitTextToSize(strip(cell.text), colW - 3);
      this.doc.text(t[0] ?? "", MX + ci * colW + 2, this.y);
    });
    this.y += rowH;

    this.doc.setFont("helvetica", "normal");

    token.rows.forEach((row, ri) => {
      if (ri % 2 === 1) {
        this.doc.setFillColor(248, 250, 252);
        this.doc.rect(MX, this.y - 4.5, CW, rowH, "F");
      }
      row.forEach((cell, ci) => {
        const t = this.doc.splitTextToSize(strip(cell.text), colW - 3);
        this.doc.text(t[0] ?? "", MX + ci * colW + 2, this.y);
      });
      this.y += rowH;
    });

    // outer border
    this.doc.setDrawColor(203, 213, 225);
    this.doc.setLineWidth(0.3);
    this.doc.rect(MX, this.y - totalH, CW, totalH, "S");

    // column separators
    for (let ci = 1; ci < cols; ci++) {
      const x = MX + ci * colW;
      this.doc.line(x, this.y - totalH, x, this.y);
    }

    this.y += 4;
    this.reset();
  }

  hr() {
    this.guard(8);
    this.y += 3;
    this.doc.setDrawColor(226, 232, 240);
    this.doc.setLineWidth(0.3);
    this.doc.line(MX, this.y, PW - MX, this.y);
    this.y += 5;
  }
}

function renderTokens(b: Builder, tokens: ReturnType<typeof marked.lexer>) {
  for (const token of tokens) {
    switch (token.type) {
      case "heading":
        b.heading(token.text, token.depth);
        break;
      case "paragraph":
        b.paragraph(token.text);
        break;
      case "code":
        b.code(token.text);
        break;
      case "blockquote": {
        // Render inner paragraph tokens so nested content is handled
        const bq = token as Tokens.Blockquote;
        const innerText = bq.tokens
          .filter((t) => t.type === "paragraph" || t.type === "text")
          .map((t) => (t as Tokens.Paragraph).text ?? "")
          .join(" ");
        b.blockquote(innerText || bq.text);
        break;
      }
      case "list":
        b.list(token as Tokens.List);
        break;
      case "table":
        b.table(token as Tokens.Table);
        break;
      case "hr":
        b.hr();
        break;
      case "space":
        break;
    }
  }
}

/**
 * Export markdown content as a PDF file.
 * Shows a native "Save As" dialog — no print dialog, no browser UI.
 */
export async function exportToPDF(title: string, content: string): Promise<void> {
  const savePath = await save({
    title: "Export as PDF",
    defaultPath: `${title}.pdf`,
    filters: [{ name: "PDF Document", extensions: ["pdf"] }],
  });
  if (!savePath) return;

  try {
    const tokens  = marked.lexer(content);
    const builder = new Builder();
    renderTokens(builder, tokens);

    const bytes = new Uint8Array(builder.doc.output("arraybuffer"));
    await writeFile(savePath, bytes);
  } catch (err) {
    throw new Error(`PDF export failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
