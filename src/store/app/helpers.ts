import { v4 as uuidv4 } from "uuid";
import type { Tab } from "../../types";
import { getFileName } from "../../lib/pathUtils";

// ─── debounced helpers ───────────────────────────────────────────────────────

let _contentPersistTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingPersistFn: (() => void) | null = null;

export function debounceContentPersist(fn: () => void) {
  _pendingPersistFn = fn;
  if (_contentPersistTimer) clearTimeout(_contentPersistTimer);
  _contentPersistTimer = setTimeout(() => { _pendingPersistFn = null; fn(); }, 300);
}

/** Flush any pending debounced persist immediately — called on window close. */
export function flushPendingPersist() {
  if (_pendingPersistFn) {
    if (_contentPersistTimer) clearTimeout(_contentPersistTimer);
    _pendingPersistFn();
    _pendingPersistFn = null;
    _contentPersistTimer = null;
  }
}

let _graphRebuildTimer: ReturnType<typeof setTimeout> | null = null;

export function debounceGraphRebuild(fn: () => void) {
  if (_graphRebuildTimer) clearTimeout(_graphRebuildTimer);
  _graphRebuildTimer = setTimeout(fn, 400);
}

/** Flush any pending debounced graph rebuild immediately — called on window close. */
export function flushPendingGraphRebuild() {
  if (_graphRebuildTimer) {
    clearTimeout(_graphRebuildTimer);
    _graphRebuildTimer = null;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

export function titleFromPath(path: string, fallback: string): string {
  const fileName = getFileName(path) || fallback;
  return fileName.replace(/\.(md|markdown|txt|nqv)$/i, "");
}

export function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: uuidv4(),
    kind: "note",
    title: "Untitled",
    content: "",
    isDirty: false,
    cursorPosition: { line: 1, column: 1 },
    scrollPosition: 0,
    editorMode: "split",
    isPinned: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}
