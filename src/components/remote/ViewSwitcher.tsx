import { LayoutGrid, List, Minus, Plus } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { GRID_SIZES, type FilesView, type GridSize } from "../../lib/filesPrefs";

export const GRID_SIZE_LABEL: Record<GridSize, string> = {
  xsmall: "Extra small", small: "Small", medium: "Medium", large: "Large", xlarge: "Extra large",
};

/** The next size up (`1`) or down (`-1`); stays at the ends. */
export function stepSize(size: GridSize, dir: 1 | -1): GridSize {
  const i = GRID_SIZES.indexOf(size);
  return GRID_SIZES[Math.min(GRID_SIZES.length - 1, Math.max(0, i + dir))];
}

/** The grid's icon size: smaller, a slider over every size, bigger. Ctrl + mouse wheel over the grid does the same. */
export function GridSizeControl({ size, onSize }: { size: GridSize; onSize: (s: GridSize) => void }) {
  const i = GRID_SIZES.indexOf(size);
  const button = "grid place-items-center h-5 w-5 rounded cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]/50 disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent";
  return (
    <div role="group" aria-label="Grid item size" className="flex items-center gap-1.5 normal-case tracking-normal">
      <span aria-hidden>Icon size</span>
      <Tooltip content="Smaller icons (Ctrl + scroll)">
        <button type="button" aria-label="Smaller icons" className={button} disabled={i === 0} onClick={() => onSize(stepSize(size, -1))}><Minus size={12} /></button>
      </Tooltip>
      <input type="range" min={0} max={GRID_SIZES.length - 1} step={1} value={i} aria-label="Icon size" aria-valuetext={GRID_SIZE_LABEL[size]}
             onChange={(e) => onSize(GRID_SIZES[Number(e.target.value)])} className="w-24 h-1 cursor-pointer accent-[var(--color-primary)]" />
      <Tooltip content="Bigger icons (Ctrl + scroll)">
        <button type="button" aria-label="Bigger icons" className={button} disabled={i === GRID_SIZES.length - 1} onClick={() => onSize(stepSize(size, 1))}><Plus size={12} /></button>
      </Tooltip>
    </div>
  );
}

function Seg({ label, tooltip, active, onClick, children }: {
  label: string; tooltip?: string; active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <Tooltip content={tooltip ?? label}>
      <button type="button" aria-label={label} aria-pressed={active} onClick={onClick}
              className={`grid place-items-center h-6 w-7 rounded cursor-pointer transition-colors ${active
                ? "bg-[var(--color-bg)] text-[var(--color-text)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]"}`}>
        {children}
      </button>
    </Tooltip>
  );
}

/** How a folder is shown: a joined List | Grid switch. The grid's size control sits above the grid. */
export function ViewSwitcher({ view, onView }: { view: FilesView; onView: (v: FilesView) => void }) {
  return (
    <div role="group" aria-label="Layout" className="inline-flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--color-bg-tertiary)]">
      <Seg label="List view" tooltip="List: size, date and permissions" active={view === "list"} onClick={() => onView("list")}><List size={14} /></Seg>
      <Seg label="Grid view" tooltip="Grid of icons" active={view === "grid"} onClick={() => onView("grid")}><LayoutGrid size={14} /></Seg>
    </div>
  );
}
