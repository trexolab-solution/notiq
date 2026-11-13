/**
 * Preferences of the remote file manager (Settings → Vault → File manager). Per-device, kept in localStorage as
 * one JSON object, so the tab and the file manager window (same origin) read the same values. They are read
 * when a file manager opens; a change applies to file managers opened afterwards.
 */

export type FilesSortKey = "name" | "size" | "mtime";
export type FilesOpenAction = "open" | "download";
export type FilesView = "list" | "grid";
export type GridSize = "small" | "medium" | "large";

/** Width in px of one grid item at each size. */
export const GRID_ITEM_PX: Record<GridSize, number> = { small: 88, medium: 124, large: 172 };

export interface FilesPrefs {
  /** Show dot files when a folder is listed. */
  showHidden: boolean;
  /** The folder as a list (rows with details) or as a grid of icons, and the grid item size. */
  view: FilesView;
  gridSize: GridSize;
  sortKey: FilesSortKey;
  sortDesc: boolean;
  /** What double-click (and Enter) does on a file: open it in the viewer, or download it. */
  openAction: FilesOpenAction;
  /** Ask before deleting. */
  confirmDelete: boolean;
  /** The text editor: wrap long lines, and its font size. */
  editorWrap: boolean;
  editorFontSize: number;
}

export const DEFAULT_FILES_PREFS: FilesPrefs = {
  showHidden: false, view: "list", gridSize: "medium", sortKey: "name", sortDesc: false, openAction: "open", confirmDelete: true, editorWrap: true, editorFontSize: 13,
};

export const EDITOR_FONT_MIN = 10;
export const EDITOR_FONT_MAX = 24;

const KEY = "pref:filesPrefs";

/** Anything unreadable or out of range falls back to the default for that field. */
export function sanitizeFilesPrefs(raw: unknown): FilesPrefs {
  const d = DEFAULT_FILES_PREFS;
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, def: boolean) => (typeof v === "boolean" ? v : def);
  const size = typeof o.editorFontSize === "number" && Number.isFinite(o.editorFontSize)
    ? Math.min(EDITOR_FONT_MAX, Math.max(EDITOR_FONT_MIN, Math.round(o.editorFontSize))) : d.editorFontSize;
  return {
    showHidden: bool(o.showHidden, d.showHidden),
    view: o.view === "grid" ? "grid" : "list",
    gridSize: o.gridSize === "small" || o.gridSize === "large" ? o.gridSize : "medium",
    sortKey: o.sortKey === "size" || o.sortKey === "mtime" || o.sortKey === "name" ? o.sortKey : d.sortKey,
    sortDesc: bool(o.sortDesc, d.sortDesc),
    openAction: o.openAction === "download" ? "download" : "open",
    confirmDelete: bool(o.confirmDelete, d.confirmDelete),
    editorWrap: bool(o.editorWrap, d.editorWrap),
    editorFontSize: size,
  };
}

export function getFilesPrefs(): FilesPrefs {
  try {
    const t = localStorage.getItem(KEY);
    return sanitizeFilesPrefs(t ? JSON.parse(t) : null);
  } catch { return { ...DEFAULT_FILES_PREFS }; }
}

/** Changes some of the preferences; the rest stay. Returns the new full set. */
export function setFilesPrefs(patch: Partial<FilesPrefs>): FilesPrefs {
  const next = sanitizeFilesPrefs({ ...getFilesPrefs(), ...patch });
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}
