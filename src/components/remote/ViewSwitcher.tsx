import { LayoutGrid, List } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import type { FilesView, GridSize } from "../../lib/filesPrefs";

const SIZES: { value: GridSize; label: string; px: number }[] = [
  { value: "small", label: "Small items", px: 6 },
  { value: "medium", label: "Medium items", px: 9 },
  { value: "large", label: "Large items", px: 12 },
];

/** The next size up (`1`) or down (`-1`); stays at the ends. */
export function stepSize(size: GridSize, dir: 1 | -1): GridSize {
  const i = SIZES.findIndex((s) => s.value === size);
  return SIZES[Math.min(SIZES.length - 1, Math.max(0, i + dir))].value;
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

/**
 * How a folder is shown: a joined List | Grid switch, and, while it is a grid, three item sizes drawn as squares
 * that grow (so no S / M / L to decode). Ctrl + mouse wheel over the grid steps the size too.
 */
export function ViewSwitcher({ view, size, onView, onSize }: {
  view: FilesView; size: GridSize; onView: (v: FilesView) => void; onSize: (s: GridSize) => void;
}) {
  const group = "inline-flex items-center gap-0.5 p-0.5 rounded-md bg-[var(--color-bg-tertiary)]";
  return (
    <div className="flex items-center gap-1.5">
      {view === "grid" && (
        <div role="group" aria-label="Grid item size" className={group}>
          {SIZES.map((s) => (
            <Seg key={s.value} label={s.label} tooltip={`${s.label} (Ctrl + scroll)`} active={size === s.value} onClick={() => onSize(s.value)}>
              <span aria-hidden className="block rounded-[2px] border-[1.5px] border-current" style={{ width: s.px, height: s.px }} />
            </Seg>
          ))}
        </div>
      )}
      <div role="group" aria-label="Layout" className={group}>
        <Seg label="List view" tooltip="List: size, date and permissions" active={view === "list"} onClick={() => onView("list")}><List size={14} /></Seg>
        <Seg label="Grid view" tooltip="Grid of icons" active={view === "grid"} onClick={() => onView("grid")}><LayoutGrid size={14} /></Seg>
      </div>
    </div>
  );
}
