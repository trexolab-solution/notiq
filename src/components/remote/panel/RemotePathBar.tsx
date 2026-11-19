import { Archive, ArchiveRestore, ArrowLeft, ArrowRight, ArrowUp, RefreshCw, Search } from "lucide-react";
import { Input } from "../../ui/Input";
import { RowIconButton } from "../../vault/ListEditor";
import { crumbs } from "../../../lib/sftp";
import { Crumb } from "./Crumb";

/**
 * The top bar: back / forward / up / refresh, the folder path (crumbs; double-click to type a path), the Filter box
 * and the Trash button.
 */
export function RemotePathBar({
  nav, path, loading, editingPath, onEditingPath, onBack, onForward, onUp, onRefresh, onNavigate,
  filter, onFilter, onFilterEscape, showTrash, onToggleTrash, trashCount,
}: {
  nav: { back: string[]; fwd: string[] };
  path: string;
  loading: boolean;
  editingPath: string | null;
  onEditingPath: (p: string | null) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onNavigate: (path: string) => void;
  filter: string;
  onFilter: (v: string) => void;
  /** Esc in the Filter box (after the filter is cleared and the box blurred). */
  onFilterEscape: () => void;
  showTrash: boolean;
  onToggleTrash: () => void;
  trashCount: number | null;
}) {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2 border-b border-[var(--color-border)]">
      <RowIconButton label="Back" tooltip="Back (Alt+Left)" icon={<ArrowLeft size={14} />} disabled={nav.back.length === 0} onClick={onBack} />
      <RowIconButton label="Forward" tooltip="Forward (Alt+Right)" icon={<ArrowRight size={14} />} disabled={nav.fwd.length === 0} onClick={onForward} />
      <RowIconButton label="Up one folder" tooltip="Up (Backspace)" icon={<ArrowUp size={14} />} disabled={path === "/"} onClick={onUp} />
      <RowIconButton label="Refresh" icon={<RefreshCw size={14} className={loading ? "animate-spin" : ""} />} onClick={onRefresh} />
      {editingPath === null ? (
        <nav aria-label="Folder path" className="flex-1 min-w-0 flex items-center overflow-x-auto h-8 rounded-md px-1.5 border border-[var(--color-border)] bg-[var(--color-bg-secondary)] cursor-text"
             onDoubleClick={() => onEditingPath(path)}>
          {crumbs(path).map((c, i, all) => (
            <span key={c.path} className="flex items-center shrink-0">
              <Crumb c={c} last={i === all.length - 1} onGo={onNavigate} />
              {i > 0 && i < all.length - 1 && <span className="text-[var(--color-text-muted)]" aria-hidden>/</span>}
            </span>
          ))}
        </nav>
      ) : (
        <Input className="flex-1 min-w-0 font-mono" value={editingPath} autoFocus spellCheck={false} aria-label="Folder path"
               onChange={(e) => onEditingPath(e.target.value)} onFocus={(e) => e.currentTarget.select()}
               onBlur={() => onEditingPath(null)}
               onKeyDown={(e) => {
                 if (e.key === "Enter") { const p = editingPath.trim(); onEditingPath(null); if (p) onNavigate(p); }
                 if (e.key === "Escape") { e.stopPropagation(); onEditingPath(null); }
               }} />
      )}
      <div className="relative w-44 shrink-0">
        <Search size={13} aria-hidden className="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--color-text-muted)]" />
        <Input className="!pl-7" value={filter} placeholder="Filter" aria-label="Filter files" spellCheck={false}
               onChange={(e) => onFilter(e.target.value)}
               onKeyDown={(e) => {
                 // Esc: clear the filter and go back to the list (a second Esc does nothing else here).
                 if (e.key === "Escape") { e.stopPropagation(); onFilter(""); e.currentTarget.blur(); onFilterEscape(); }
               }} />
      </div>
      <span className="relative inline-flex">
        <RowIconButton label="Trash" pressed={showTrash} onClick={onToggleTrash}
                       tooltip={trashCount ? `Trash: ${trashCount} item${trashCount === 1 ? "" : "s"}. Restore or empty` : "Trash is empty"}
                       icon={trashCount ? <ArchiveRestore size={15} className="text-[var(--color-warning,#d97706)]" /> : <Archive size={15} />} />
        {!!trashCount && (
          <span aria-hidden className="pointer-events-none absolute -top-1 -right-1 min-w-[15px] h-[15px] px-1 grid place-items-center rounded-full text-[9px] font-semibold leading-none bg-[var(--color-warning,#d97706)] text-[var(--color-bg)]">
            {trashCount > 99 ? "99+" : trashCount}
          </span>
        )}
      </span>
    </div>
  );
}
