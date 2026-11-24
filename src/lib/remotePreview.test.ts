import { describe, expect, it } from "vitest";
import {
  cellNumber, delimiterName, isNumericColumn, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, parseTable, previewKind, sortRows, tableDelimiter,
} from "./remotePreview";

describe("previewKind", () => {
  it("Markdown files are shown as a page, CSV and TSV as a table, the rest only as text", () => {
    for (const n of ["README.md", "notes.MD", "a.markdown", "x.mdown"]) expect(previewKind(n)).toBe("markdown");
    for (const n of ["data.csv", "DATA.CSV", "table.tsv"]) expect(previewKind(n)).toBe("table");
    for (const n of ["a.txt", "app.json", "script.sh", "noext", "md", "archive.csv.gz", ".csv", ""]) {
      expect(previewKind(n)).toBe(n === ".csv" ? "table" : null);
    }
  });
});

describe("parseTable", () => {
  it("reads rows and columns, quotes included", () => {
    const t = parseTable('name,qty,note\nbolt,12,"a, b"\nnut,3,"say ""hi"""\n', "parts.csv");
    expect(t.rows).toEqual([["name", "qty", "note"], ["bolt", "12", "a, b"], ["nut", "3", 'say "hi"']]);
    expect([t.columns, t.totalRows, t.truncated, t.delimiter]).toEqual([3, 3, false, ","]);
  });
  it("tells semicolon files from comma files, and .tsv is always tab separated", () => {
    expect(parseTable("a;b\n1;2", "x.csv").delimiter).toBe(";");
    expect(parseTable("a,b\n1,2", "x.csv").delimiter).toBe(",");
    expect(tableDelimiter("x.tsv", "a,b,c\n1,2,3")).toBe("\t");
    expect(parseTable("a\tb\n1\t2", "x.tsv").rows).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("pads short rows so every row has the same columns", () => {
    expect(parseTable("a,b,c\n1\n1,2,3,4", "x.csv").rows).toEqual([["a", "b", "c", ""], ["1", "", "", ""], ["1", "2", "3", "4"]]);
  });
  it("cuts a long file and a wide one, and says how long it really is", () => {
    const long = Array.from({ length: MAX_TABLE_ROWS + 10 }, (_, i) => `r${i},x`).join("\n");
    const t = parseTable(long, "x.csv");
    expect([t.rows.length, t.totalRows, t.truncated]).toEqual([MAX_TABLE_ROWS, MAX_TABLE_ROWS + 10, true]);
    const wide = parseTable(Array.from({ length: MAX_TABLE_COLUMNS + 5 }, (_, i) => `c${i}`).join(","), "x.csv");
    expect([wide.columns, wide.truncated]).toEqual([MAX_TABLE_COLUMNS, true]);
  });
  it("an empty file is an empty table", () => {
    expect(parseTable("", "x.csv")).toMatchObject({ rows: [], columns: 0, totalRows: 0, truncated: false });
  });
});

describe("numbers in cells", () => {
  it("reads numbers as people write them, and nothing else", () => {
    expect(["12", "-3", "+4.5", "1,234", "1,234.56", "12%", " 7 "].map(cellNumber)).toEqual([12, -3, 4.5, 1234, 1234.56, 12, 7]);
    for (const bad of ["", "abc", "1,23", "1.2.3", "12a", "0x10", "1e5", "--1", "$5"]) expect(cellNumber(bad)).toBeNull();
  });
  it("a column is numeric when most of its filled cells are", () => {
    expect(isNumericColumn([["1"], ["2"], ["3"], [""], ["x"]], 0)).toBe(false); // 3 of 4 filled: 75%
    expect(isNumericColumn([["1"], ["2"], ["3"], ["4"], ["x"], [""]], 0)).toBe(true); // 4 of 5: 80%
    expect(isNumericColumn([[""], [""]], 0)).toBe(false);
    expect(isNumericColumn([["a"], ["b"]], 0)).toBe(false);
  });
});

describe("sortRows", () => {
  const rows = [["b", "10"], ["a", "9"], ["c", ""], ["d", "100"]];
  it("sorts numbers by value, not as text, with empty cells last either way", () => {
    expect(sortRows(rows, 1, "asc").map((r) => r[1])).toEqual(["9", "10", "100", ""]);
    expect(sortRows(rows, 1, "desc").map((r) => r[1])).toEqual(["100", "10", "9", ""]);
  });
  it("sorts text by name, with the numbers inside names in order, ignoring case", () => {
    expect(sortRows([["file10"], ["File2"], ["file1"]], 0, "asc").map((r) => r[0])).toEqual(["file1", "File2", "file10"]);
    expect(sortRows([["b"], ["A"], ["c"]], 0, "desc").map((r) => r[0])).toEqual(["c", "b", "A"]);
  });
  it("doesn't change the rows it was given", () => {
    const copy = JSON.stringify(rows);
    sortRows(rows, 0, "desc");
    expect(JSON.stringify(rows)).toBe(copy);
  });
  it("names the separator", () => {
    expect([",", ";", "\t"].map((d) => delimiterName(d as "," | ";" | "\t"))).toEqual(["comma", "semicolon", "tab"]);
  });
});
