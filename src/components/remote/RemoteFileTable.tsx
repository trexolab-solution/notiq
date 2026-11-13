import { ChevronDown, ChevronUp, File, FileSymlink, Folder, FolderSymlink } from "lucide-react";
import { formatBytes } from "../../lib/vaultBackup";
import { formatModified, modeString, type RemoteEntry, type SortKey, type SortState } from "../../lib/sftp";
import { useEntryDnd } from "./useEntryDnd";

const COLUMNS = "grid-cols-[minmax(0,1fr)_88px_150px_84px]";

interface Props {
  entries: RemoteEntry[];
  /** The folder being listed (a dragged item dropped on a folder row here is moved into it). */
  dir: string;
  selected: ReadonlySet<string>;
  sort: SortState;
  onSort: (key: SortKey) => void;
  /** Click on a row: `mode` says whether Ctrl/Cmd (toggle) or Shift (range) was held. */
  onSelect: (name: string, mode: "single" | "toggle" | "range") => void;
  onOpen: (entry: RemoteEntry) => void;
  /** Right-click on a row (`entry`) or on the empty space below the rows (`null`), at screen position x, y. */
  onMenu: (entry: RemoteEntry | null, x: number, y: number) => void;
  /** The empty-state text (an empty folder, or nothing matches the filter). */
  empty: string;
}

function Header({ label, k, sort, onSort, right }: { label: string; k?: SortKey; sort: SortState; onSort: (k: SortKey) => void; right?: boolean }) {
  const active = k && sort.key === k;
  const content = (
    <span className={`inline-flex items-center gap-1 ${right ? "justify-end w-full" : ""}`}>
      {label}
      {active && (sort.desc ? <ChevronDown size={11} aria-hidden /> : <ChevronUp size={11} aria-hidden />)}
    </span>
  );
  if (!k) return <div className={`px-2 ${right ? "text-right" : ""}`}>{content}</div>;
  return (
    <button type="button" onClick={() => onSort(k)} aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
            className={`px-2 text-left text-[11px] font-medium uppercase tracking-wide cursor-pointer hover:text-[var(--color-text)] ${active ? "text-[var(--color-text)]" : ""} ${right ? "text-right" : ""}`}>
      {content}
    </button>
  );
}

function Glyph({ e }: { e: RemoteEntry }) {
  if (e.kind === "dir") return e.link ? <FolderSymlink size={15} aria-hidden /> : <Folder size={15} aria-hidden />;
  return e.link ? <FileSymlink size={15} aria-hidden /> : <File size={15} aria-hidden />;
}

function Row({ e, dir, on, onSelect, onOpen, onMenu }: {
  e: RemoteEntry; dir: string; on: boolean; onSelect: Props["onSelect"]; onOpen: Props["onOpen"]; onMenu: Props["onMenu"];
}) {
  const dnd = useEntryDnd(e, dir);
  return (
    <div ref={dnd.setRef} role="row" aria-selected={on} tabIndex={-1} data-name={e.name} {...dnd.listeners}
         onClick={(ev) => onSelect(e.name, ev.shiftKey ? "range" : ev.ctrlKey || ev.metaKey ? "toggle" : "single")}
         onDoubleClick={() => onOpen(e)}
         onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); onMenu(e, ev.clientX, ev.clientY); }}
         className={`grid ${COLUMNS} items-center h-8 text-sm cursor-default select-none ${dnd.dragging ? "opacity-40" : ""} ${dnd.over
           ? "bg-[var(--color-primary)]/20 ring-1 ring-inset ring-[var(--color-primary)]"
           : on ? "bg-[var(--color-primary)]/15 text-[var(--color-text)]" : "hover:bg-[var(--color-bg-tertiary)]"}`}>
      <div role="gridcell" className="flex items-center gap-2 px-2 min-w-0">
        <span className={e.kind === "dir" ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}><Glyph e={e} /></span>
        <span className="truncate" title={e.name}>{e.name}</span>
      </div>
      <div role="gridcell" className="px-2 text-right text-xs tabular-nums text-[var(--color-text-muted)]">
        {e.kind === "dir" ? "" : formatBytes(e.size)}
      </div>
      <div role="gridcell" className="px-2 text-xs text-[var(--color-text-muted)] truncate">{formatModified(e.mtime)}</div>
      <div role="gridcell" className="px-2 text-[11px] font-mono text-[var(--color-text-muted)] truncate" title={modeString(e.mode)}>
        {modeString(e.mode)}
      </div>
    </div>
  );
}

/** The folder's listing: name, size, modified, permissions; click selects, double-click opens, drag moves. */
export function RemoteFileTable({ entries, dir, selected, sort, onSort, onSelect, onOpen, onMenu, empty }: Props) {
  return (
    <div role="grid" aria-label="Remote files" aria-multiselectable className="flex flex-col min-h-0 flex-1">
      <div role="row" className={`grid ${COLUMNS} items-center h-7 shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] border-b border-[var(--color-border)]`}>
        <Header label="Name" k="name" sort={sort} onSort={onSort} />
        <Header label="Size" k="size" sort={sort} onSort={onSort} right />
        <Header label="Modified" k="mtime" sort={sort} onSort={onSort} />
        <Header label="Access" sort={sort} onSort={onSort} />
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto" data-remote-rows="" onContextMenu={(ev) => { ev.preventDefault(); onMenu(null, ev.clientX, ev.clientY); }}>
        {entries.length === 0 && <p className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">{empty}</p>}
        {entries.map((e) => <Row key={e.name} e={e} dir={dir} on={selected.has(e.name)} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} />)}
      </div>
    </div>
  );
}
