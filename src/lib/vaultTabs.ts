import type { Tab } from "../types";
import { isVaultPath } from "./vault";

/**
 * How a vault entry opens from the sidebar (VS Code's "preview editor" model):
 * - "preview": reuse the one preview tab (italic title) as long as it has no unsaved edits;
 * - "permanent": always a tab of its own (Ctrl/Cmd+click, middle-click, "Open in new tab", double-click).
 * Only vault entries use preview tabs; ordinary files always open permanent.
 */
export type VaultOpenMode = "preview" | "permanent";

export type VaultOpenPlan =
  /** Already open: focus it (and make it permanent when `promote`). */
  | { action: "focus"; tabId: string; promote: boolean }
  /** Swap the clean preview tab `tabId` for the new entry, in the same place. */
  | { action: "replace"; tabId: string }
  /** Add a new tab (a preview tab when `preview`). */
  | { action: "new"; preview: boolean };

const norm = (p?: string) => (p ? p.replace(/\\/g, "/").toLowerCase() : "");

/** A preview tab that can be swapped out without losing anything. */
export function isReusablePreview(t: Tab): boolean {
  return !!t.isPreview && !t.isDirty && !t.isPinned && t.kind === "note" && isVaultPath(t.filePath);
}

/** Decides what opening `path` in `mode` does to the tab list. Pure. */
export function planVaultOpen(tabs: Tab[], path: string, mode: VaultOpenMode): VaultOpenPlan {
  const key = norm(path);
  const existing = tabs.find((t) => t.filePath && norm(t.filePath) === key);
  if (existing) return { action: "focus", tabId: existing.id, promote: mode === "permanent" && !!existing.isPreview };
  if (mode === "permanent") return { action: "new", preview: false };
  const reuse = tabs.find(isReusablePreview);
  return reuse ? { action: "replace", tabId: reuse.id } : { action: "new", preview: true };
}

/** Ctrl+click (Cmd+click on macOS) or a middle click opens in a new permanent tab. */
export function openModeFromEvent(e: { ctrlKey?: boolean; metaKey?: boolean; button?: number }): VaultOpenMode {
  return e.ctrlKey || e.metaKey || e.button === 1 ? "permanent" : "preview";
}
