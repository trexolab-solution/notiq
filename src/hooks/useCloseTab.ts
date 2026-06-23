import { useCallback, useState } from "react";
import { useAppStore } from "../store";
import type { Tab } from "../types";

export interface CloseTabControls {
  /** The tab currently awaiting close-confirmation (null = no dialog). */
  pendingTab: Tab | null;
  /**
   * Request to close a tab.
   * - Note with unsaved content → confirmation dialog.
   * - Whiteboard with drawn elements → confirmation dialog.
   * - Otherwise → close immediately.
   */
  requestClose: (id: string) => void;
  /** User chose Save → save the file, then close. (notes only) */
  handleSaveAndClose: () => Promise<void>;
  /** User chose Discard → close without saving. */
  handleDiscardAndClose: () => void;
  /** User cancelled → dismiss the dialog. */
  handleCancelClose: () => void;
}

/** Returns true when a whiteboard tab has any drawn elements persisted. */
function whiteboardHasContent(tabId: string): boolean {
  try {
    const raw = localStorage.getItem(`smart-note:wb-${tabId}`);
    if (!raw) return false;
    const state = JSON.parse(raw) as { elements?: unknown[] };
    return Array.isArray(state.elements) && state.elements.length > 0;
  } catch {
    return false;
  }
}

/**
 * Encapsulates all "close tab with unsaved-changes guard" logic.
 * The caller is responsible for rendering the `ConfirmDialog` when
 * `pendingTab` is non-null.
 */
export function useCloseTab(): CloseTabControls {
  const tabs          = useAppStore((s) => s.tabs);
  const removeTab     = useAppStore((s) => s.removeTab);
  const saveTabToFile = useAppStore((s) => s.saveTabToFile);

  const [pendingTab, setPendingTab] = useState<Tab | null>(null);

  const requestClose = useCallback((id: string) => {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;

    // Pinned tabs cannot be closed — unpin first
    if (tab.isPinned) return;

    if (tab.kind === "whiteboard") {
      // Only ask if the canvas has drawn elements worth losing
      if (whiteboardHasContent(id)) { setPendingTab(tab); return; }
      removeTab(id);
      return;
    }

    // Note: dirty OR has content but was never saved to disk
    const hasUnsaved = tab.isDirty || (!tab.filePath && tab.content.trim().length > 0);
    if (hasUnsaved) { setPendingTab(tab); return; }

    removeTab(id);
  }, [tabs, removeTab]);

  const handleSaveAndClose = useCallback(async () => {
    if (!pendingTab) return;
    const saved = await saveTabToFile(pendingTab.id);
    // Only close if the save completed (user didn't cancel the file-picker)
    if (saved) { removeTab(pendingTab.id); setPendingTab(null); }
  }, [pendingTab, saveTabToFile, removeTab]);

  const handleDiscardAndClose = useCallback(() => {
    if (!pendingTab) return;
    removeTab(pendingTab.id);
    setPendingTab(null);
  }, [pendingTab, removeTab]);

  const handleCancelClose = useCallback(() => setPendingTab(null), []);

  return { pendingTab, requestClose, handleSaveAndClose, handleDiscardAndClose, handleCancelClose };
}
