/** Resizable side panels: pure width clamping + per-device persistence (localStorage like the other prefs). */

export interface PanelWidthSpec {
  /** localStorage key the preferred width is kept under. */
  key: string;
  min: number;
  def: number;
  /** Keyboard step (arrow keys on the resize handle). */
  step: number;
  /** Upper bound for the given available width (window or container); clamped up to `min`. */
  maxFor: (available: number) => number;
}

export interface PanelWidth extends PanelWidthSpec {
  max: (available: number) => number;
  clamp: (width: number, available: number) => number;
  load: () => number;
  save: (width: number) => void;
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0);

export function panelWidth(spec: PanelWidthSpec): PanelWidth {
  const max = (available: number) => Math.max(spec.min, Math.floor(spec.maxFor(finite(available))));
  const clamp = (width: number, available: number) => {
    const w = Number.isFinite(width) ? Math.round(width) : spec.def;
    return Math.min(max(available), Math.max(spec.min, w));
  };
  /** The stored preference (unclamped to any window: callers clamp it to what's available right now). */
  const load = () => {
    try {
      const raw = localStorage.getItem(spec.key);
      const n = raw === null ? NaN : Number(raw);
      return Number.isFinite(n) ? Math.max(spec.min, Math.round(n)) : spec.def;
    } catch {
      return spec.def;
    }
  };
  const save = (width: number) => {
    try { localStorage.setItem(spec.key, String(Math.round(width))); } catch { /* storage unavailable */ }
  };
  return { ...spec, max, clamp, load, save };
}
