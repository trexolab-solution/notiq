import type { Tab } from "../types";
import { isVaultPath } from "./vault";
import { isStructuredEntryTab } from "./entryName";

/**
 * What closing a tab should do. Pure; `whiteboardHasContent` is passed in so this
 * stays testable without localStorage. Unit-tested in closeGuard.test.ts.
 * - "blocked": pinned tabs can't be closed (unpin first).
 * - "confirm": ask first (unsaved edits, or a whiteboard with drawings).
 * - "close": nothing to lose.
 */
export type CloseDecision = "blocked" | "confirm" | "close";

type GuardTab = Pick<Tab, "id" | "kind" | "isPinned" | "isDirty" | "filePath" | "content"> & Partial<Pick<Tab, "vaultLocked" | "transient">>;

export function closeDecision(tab: GuardTab, whiteboardHasContent: (id: string) => boolean): CloseDecision {
  if (tab.isPinned) return "blocked";
  if (tab.kind === "settings" || tab.kind === "files") return "close";
  if (tab.kind === "whiteboard") return whiteboardHasContent(tab.id) ? "confirm" : "close";
  // A locked vault tab holds no plaintext, so there's nothing it could lose.
  if (tab.vaultLocked) return "close";
  // A generated page (What's New) that nobody edited has nothing to lose.
  if (tab.transient && !tab.isDirty) return "close";
  // Dirty, or has content but was never saved to disk.
  return tab.isDirty || (!tab.filePath && tab.content.trim().length > 0) ? "confirm" : "close";
}

/** Wording for the unsaved-changes dialog, fitted to what the tab is. */
export function unsavedCloseText(tab: Pick<Tab, "filePath" | "vaultExt">): { message: string; confirmLabel: string } {
  if (isStructuredEntryTab(tab)) {
    return { message: "This vault entry has unsaved changes. Save them to the vault before closing?", confirmLabel: "Save" };
  }
  if (isVaultPath(tab.filePath)) {
    return { message: "This vault note has unsaved changes. Save them to the vault before closing?", confirmLabel: "Save" };
  }
  return tab.filePath
    ? { message: "This note has unsaved changes. Save before closing?", confirmLabel: "Save" }
    : { message: "This note has never been saved to disk. Close without saving?", confirmLabel: "Save As" };
}

/** Open vault tabs (entries and notes) whose edits would be lost if the app quit now. */
export function dirtyVaultTabs<T extends Pick<Tab, "filePath" | "isDirty"> & Partial<Pick<Tab, "vaultLocked">>>(tabs: T[]): T[] {
  return tabs.filter((t) => isVaultPath(t.filePath) && !t.vaultLocked && t.isDirty);
}
