import { useEffect, useRef } from "react";
import {
  ChevronDown, ChevronUp, File, FileArchive, FileAudio, FileCode, FileImage, FileSymlink, FileText, FileVideo, Folder, FolderSymlink,
} from "lucide-react";
import { formatBytes } from "../../lib/vaultBackup";
import { imageMime, type RemoteEntry, type SortKey, type SortState } from "../../lib/sftp";
import { GRID_ITEM_PX, type GridSize } from "../../lib/filesPrefs";
import { useEntryDnd } from "./useEntryDnd";

export type FileIcon = "folder" | "image" | "text" | "code" | "archive" | "audio" | "video" | "file";

const BY_EXT: Record<string, FileIcon> = {
  txt: "text", md: "text", log: "text", csv: "text", pdf: "text", doc: "text", docx: "text", rtf: "text",
  js: "code", ts: "code", tsx: "code", jsx: "code", py: "code", rs: "code", go: "code", java: "code", c: "code", cpp: "code", h: "code",
  sh: "code", bash: "code", json: "code", yml: "code", yaml: "code", toml: "code", xml: "code", html: "code", css: "code", sql: "code", conf: "code", ini: "code",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", bz2: "archive", xz: "archive", "7z": "archive", rar: "archive",
  mp3: "audio", wav: "audio", flac: "audio", ogg: "audio", m4a: "audio",
  mp4: "video", mkv: "video", mov: "video", avi: "video", webm: "video",
};

/** Which icon a grid item gets: by kind, and for files by extension. */
export function fileIconFor(e: Pick<RemoteEntry, "name" | "kind">): FileIcon {
  if (e.kind === "dir") return "folder";
  if (imageMime(e.name)) return "image";
  const i = e.name.lastIndexOf(".");
  return (i > 0 && BY_EXT[e.name.slice(i + 1).toLowerCase()]) || "file";
}

const GLYPH = { image: FileImage, text: FileText, code: FileCode, archive: FileArchive, audio: FileAudio, video: FileVideo, file: File } as const;
const ICON_PX: Record<GridSize, number> = { small: 30, medium: 42, large: 60 };

function Glyph({ e, size }: { e: RemoteEntry; size: number }) {
  const kind = fileIconFor(e);
  if (kind === "folder") return e.link ? <FolderSymlink size={size} strokeWidth={1.4} aria-hidden /> : <Folder size={size} strokeWidth={1.4} aria-hidden />;
  if (e.link) return <FileSymlink size={size} strokeWidth={1.4} aria-hidden />;
  const G = GLYPH[kind];
  return <G size={size} strokeWidth={1.4} aria-hidden />;
}

const SORTS: { key: SortKey; label: string }[] = [{ key: "name", label: "Name" }, { key: "size", label: "Size" }, { key: "mtime", label: "Modified" }];

interface Props {
  entries: RemoteEntry[];
  /** The folder being listed (a dragged item dropped on a folder here is moved into it). */
  dir: string;
  selected: ReadonlySet<string>;
  sort: SortState;
  onSort: (key: SortKey) => void;
  size: GridSize;
  /** Ctrl + mouse wheel over the grid: `1` bigger items, `-1` smaller. */
  onZoom: (dir: 1 | -1) => void;
  onSelect: (name: string, mode: "single" | "toggle" | "range") => void;
  onOpen: (entry: RemoteEntry) => void;
  onMenu: (entry: RemoteEntry | null, x: number, y: number) => void;
  empty: string;
}

function GridItem({ e, dir, on, size, icon, onSelect, onOpen, onMenu }: {
  e: RemoteEntry; dir: string; on: boolean; size: GridSize; icon: number;
  onSelect: Props["onSelect"]; onOpen: Props["onOpen"]; onMenu: Props["onMenu"];
}) {
  const dnd = useEntryDnd(e, dir);
  return (
    <div ref={dnd.setRef} role="row" aria-selected={on} tabIndex={-1} data-name={e.name} title={e.name} {...dnd.listeners}
         onClick={(ev) => { ev.stopPropagation(); onSelect(e.name, ev.shiftKey ? "range" : ev.ctrlKey || ev.metaKey ? "toggle" : "single"); }}
         onDoubleClick={() => onOpen(e)}
         onContextMenu={(ev) => { ev.preventDefault(); ev.stopPropagation(); onMenu(e, ev.clientX, ev.clientY); }}
         className={`flex flex-col items-center gap-1 px-1.5 py-2 rounded-md text-center cursor-default select-none ${dnd.dragging ? "opacity-40" : ""} ${dnd.over
           ? "bg-[var(--color-primary)]/20 ring-2 ring-[var(--color-primary)]"
           : on ? "bg-[var(--color-primary)]/15 ring-1 ring-[var(--color-primary)]/40" : "hover:bg-[var(--color-bg-tertiary)]"}`}>
      <span role="gridcell" className={e.kind === "dir" ? "text-[var(--color-primary)]" : "text-[var(--color-text-muted)]"}>
        <Glyph e={e} size={icon} />
      </span>
      <span className={`w-full break-words text-[var(--color-text)] ${size === "small" ? "text-[11px] line-clamp-2" : "text-xs line-clamp-2"}`}>{e.name}</span>
      {size !== "small" && e.kind !== "dir" && <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{formatBytes(e.size)}</span>}
    </div>
  );
}

/** The folder as a grid of icons (same selection, open and right-click behaviour as the list). */
export function RemoteFileGrid({ entries, dir, selected, sort, onSort, size, onZoom, onSelect, onOpen, onMenu, empty }: Props) {
  const icon = ICON_PX[size];
  const scroller = useRef<HTMLDivElement>(null);
  const zoom = useRef(onZoom);
  zoom.current = onZoom;
  // A native, non-passive listener: React's onWheel can't stop the page itself from zooming.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoom.current(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);
  return (
    <div role="grid" aria-label="Remote files" aria-multiselectable className="flex flex-col min-h-0 flex-1">
      <div className="flex items-center gap-1 h-7 px-3 shrink-0 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
        <span className="mr-1">Sort</span>
        {SORTS.map((s) => {
          const active = sort.key === s.key;
          return (
            <button key={s.key} type="button" onClick={() => onSort(s.key)} aria-pressed={active}
                    className={`inline-flex items-center gap-1 px-2 h-5 rounded cursor-pointer hover:text-[var(--color-text)] ${active ? "text-[var(--color-text)] bg-[var(--color-bg-tertiary)]" : ""}`}>
              {s.label}{active && (sort.desc ? <ChevronDown size={11} aria-hidden /> : <ChevronUp size={11} aria-hidden />)}
            </button>
          );
        })}
      </div>
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto p-3" data-remote-rows="" data-remote-grid=""
           onContextMenu={(ev) => { ev.preventDefault(); onMenu(null, ev.clientX, ev.clientY); }}
           onClick={(ev) => { if (ev.target === ev.currentTarget) onSelect("", "single"); }}>
        {entries.length === 0 && <p className="px-3 py-8 text-center text-sm text-[var(--color-text-muted)]">{empty}</p>}
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${GRID_ITEM_PX[size]}px, 1fr))` }}>
          {entries.map((e) => (
            <GridItem key={e.name} e={e} dir={dir} on={selected.has(e.name)} size={size} icon={icon} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} />
          ))}
        </div>
      </div>
    </div>
  );
}
