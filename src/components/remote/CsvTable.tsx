import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { delimiterName, isNumericColumn, MAX_TABLE_COLUMNS, MAX_TABLE_ROWS, parseTable, sortRows, type SortDir } from "../../lib/remotePreview";

/**
 * A CSV or TSV file as a table: numbered rows, a header that stays in view, columns that sort when their title is
 * clicked (numbers as numbers), numbers aligned to the right. Cut at 5,000 rows and 100 columns, and says so.
 */
export function CsvTable({ text, name }: { text: string; name: string }) {
  const table = useMemo(() => parseTable(text, name), [text, name]);
  const [header, setHeader] = useState(true);
  const [sort, setSort] = useState<{ col: number; dir: SortDir } | null>(null);

  const head = header ? table.rows[0] : null;
  const body = useMemo(() => {
    const rows = header ? table.rows.slice(1) : table.rows;
    return sort ? sortRows(rows, sort.col, sort.dir) : rows;
  }, [table, header, sort]);
  const numeric = useMemo(() => Array.from({ length: table.columns }, (_, c) => isNumericColumn(body, c)), [body, table.columns]);

  if (table.rows.length === 0) {
    return <p className="absolute inset-0 grid place-items-center text-sm text-[var(--color-text-muted)]">This file is empty.</p>;
  }

  /** Click: ascending, again: descending, again: the file's own order. */
  const clickColumn = (col: number) => setSort((s) => (!s || s.col !== col ? { col, dir: "asc" } : s.dir === "asc" ? { col, dir: "desc" } : null));

  return (
    <div className="absolute inset-0 flex flex-col bg-[var(--color-bg)]">
      <div className="min-h-0 flex-1 overflow-auto" data-testid="csv-scroll">
        <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]" aria-label={name}>
          <thead className="sticky top-0 z-10">
            <tr>
              <th scope="col" className="sticky left-0 z-20 w-12 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1.5 text-right text-[11px] font-normal text-[var(--color-text-muted)]">#</th>
              {Array.from({ length: table.columns }, (_, c) => {
                const on = sort?.col === c;
                return (
                  <th key={c} scope="col" aria-sort={on ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                      className="border-b border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0 text-left font-semibold">
                    <button type="button" onClick={() => clickColumn(c)} title="Click to sort"
                            className={`flex w-full min-w-[96px] max-w-[320px] cursor-pointer items-center gap-1.5 px-3 py-1.5 hover:bg-[var(--color-bg-tertiary)] ${numeric[c] ? "flex-row-reverse text-right" : ""}`}>
                      <span className="min-w-0 truncate">{head ? (head[c] || `Column ${c + 1}`) : `Column ${c + 1}`}</span>
                      {on && (sort!.dir === "asc" ? <ArrowUp size={12} className="shrink-0 text-[var(--color-primary)]" aria-hidden /> : <ArrowDown size={12} className="shrink-0 text-[var(--color-primary)]" aria-hidden />)}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="hover:bg-[var(--color-bg-tertiary)]">
                <td className="sticky left-0 border-b border-r border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-right text-[11px] tabular-nums text-[var(--color-text-muted)]">{r + 1}</td>
                {row.map((cell, c) => (
                  <td key={c} title={cell.length > 40 ? cell : undefined}
                      className={`max-w-[320px] truncate border-b border-r border-[var(--color-border)]/60 px-3 py-1 ${numeric[c] ? "text-right tabular-nums" : ""}`}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 items-center gap-4 border-t border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-muted)]" role="status" data-testid="csv-status">
        <span>
          {(header ? table.totalRows - 1 : table.totalRows).toLocaleString()} {(header ? table.totalRows - 1 : table.totalRows) === 1 ? "row" : "rows"} × {table.columns} {table.columns === 1 ? "column" : "columns"} · {delimiterName(table.delimiter)} separated
        </span>
        {table.truncated && <span className="text-[var(--color-warning,#d97706)]">Showing the first {MAX_TABLE_ROWS.toLocaleString()} rows and {MAX_TABLE_COLUMNS} columns. Open the Text view or download for the rest.</span>}
        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[var(--color-text)]">
          <input type="checkbox" checked={header} onChange={(e) => { setHeader(e.target.checked); setSort(null); }} />
          First row is the header
        </label>
      </div>
    </div>
  );
}
