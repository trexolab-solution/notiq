import { detectDelimiter, parseCsv, type Delimiter } from "./csvImport";

/** How a remote text file can also be shown, besides the editor: Markdown as a page, CSV and TSV as a table. */

export type PreviewKind = "markdown" | "table";

/** Which kind of preview a file name gets, or `null` when it is only edited as text. */
export function previewKind(name: string): PreviewKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (ext === "md" || ext === "markdown" || ext === "mdown") return "markdown";
  if (ext === "csv" || ext === "tsv") return "table";
  return null;
}

/** The most rows and columns a table shows (a larger file is cut, and says so). */
export const MAX_TABLE_ROWS = 5000;
export const MAX_TABLE_COLUMNS = 100;

export interface Table {
  /** Every row padded to the same number of columns, cut to the limits above. */
  rows: string[][];
  columns: number;
  delimiter: Delimiter;
  /** How many rows the file has in all (more than `rows.length` when it was cut). */
  totalRows: number;
  /** The file has more rows or more columns than are shown. */
  truncated: boolean;
}

/** `.tsv` is tab separated; anything else is looked at to tell comma, semicolon or tab. */
export function tableDelimiter(name: string, text: string): Delimiter {
  return name.toLowerCase().endsWith(".tsv") ? "\t" : detectDelimiter(text);
}

/** The file's text as a table. */
export function parseTable(text: string, name = ""): Table {
  const delimiter = tableDelimiter(name, text);
  const all = parseCsv(text, delimiter);
  const widest = all.reduce((n, r) => Math.max(n, r.length), 0);
  const columns = Math.min(widest, MAX_TABLE_COLUMNS);
  const rows = all.slice(0, MAX_TABLE_ROWS).map((r) => Array.from({ length: columns }, (_, i) => r[i] ?? ""));
  return { rows, columns, delimiter, totalRows: all.length, truncated: all.length > MAX_TABLE_ROWS || widest > MAX_TABLE_COLUMNS };
}

/** A number as people write it in a table ("1,234.5", "-3", "12%"), or `null` when the text is not one. */
export function cellNumber(cell: string): number | null {
  const t = cell.trim().replace(/%$/, "");
  if (!t || !/^[-+]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(t)) return null;
  return Number(t.replace(/,/g, ""));
}

/** Whether most of a column's cells are numbers (they are then aligned to the right and sorted as numbers). */
export function isNumericColumn(rows: readonly string[][], col: number): boolean {
  const filled = rows.map((r) => r[col]).filter((c) => c.trim() !== "");
  return filled.length > 0 && filled.filter((c) => cellNumber(c) != null).length / filled.length >= 0.8;
}

export type SortDir = "asc" | "desc";

/** The rows ordered by a column: numbers by value, other text by name with numbers inside it in order; empty cells last. */
export function sortRows(rows: readonly string[][], col: number, dir: SortDir): string[][] {
  const numeric = isNumericColumn(rows, col);
  const sign = dir === "asc" ? 1 : -1;
  const text = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...rows].sort((a, b) => {
    const x = a[col], y = b[col];
    if (x.trim() === "" || y.trim() === "") return x.trim() === y.trim() ? 0 : x.trim() === "" ? 1 : -1; // empty last, either way
    if (numeric) {
      const nx = cellNumber(x), ny = cellNumber(y);
      if (nx != null && ny != null) return sign * (nx - ny);
      if (nx != null || ny != null) return nx != null ? -1 : 1;
    }
    return sign * text.compare(x, y);
  });
}

/** "comma", "semicolon" or "tab" for the status line. */
export function delimiterName(d: Delimiter): string {
  return d === "," ? "comma" : d === ";" ? "semicolon" : "tab";
}
