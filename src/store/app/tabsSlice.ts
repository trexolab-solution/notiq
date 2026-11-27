import type { Tab } from "../../types";
import { isVaultPath } from "../../lib/vault";
import { scrubMonacoModels } from "../../lib/vaultMemory";
import { cleanupTabTemp } from "../../lib/attachments";
import { setCodeDraft } from "../../lib/codeDrafts";
import { forgetEntryTab } from "../../lib/entryUi";
import { debounceContentPersist, makeTab } from "./helpers";
import type { SliceContext } from "./context";
import type { AppState } from "./state";

export type TabsSlice = Pick<
  AppState,
  | "tabs" | "activeTabId" | "addTab" | "removeTab" | "setActiveTab" | "updateTabContent" | "updateTabTitle"
  | "updateTabCursor" | "updateTabScroll" | "updateTabEditorMode" | "markTabClean" | "addAttachment"
  | "togglePinTab" | "reorderTabs"
>;

/** Open tabs: add, close, edit, pin and reorder. */
export function createTabsSlice({ set, get, persist, updateTab }: SliceContext): TabsSlice {
  return {
    tabs: [],
    activeTabId: null,

    addTab(overrides = {}) {
      const { defaultEditorMode } = get();
      const tab = makeTab({ editorMode: defaultEditorMode, ...overrides });
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, sessionReady: true }));
      persist();
    },

    removeTab(id) {
      const target = get().tabs.find((t) => t.id === id);
      if (!target) return;
      // Pinned tabs cannot be closed — unpin first
      if (target.isPinned) return;
      if (target.kind === "settings") set({ settingsTarget: null });
      setCodeDraft(id, "");
      forgetEntryTab(id);
      // Clean up whiteboard-specific localStorage when a whiteboard tab is closed
      if (target.kind === "whiteboard") {
        try { localStorage.removeItem(`smart-note:wb-${id}`); } catch { /* ignore */ }
      }
      // Vault note: drop its decrypted text from the editor-model cache.
      if (isVaultPath(target.filePath)) setTimeout(() => void scrubMonacoModels([id]), 100);
      // Clean up temp attachment folder if this tab had unsaved pasted images
      if (target.attachments && Object.keys(target.attachments).length > 0) {
        cleanupTabTemp(id).catch((e) => console.warn("removeTab: temp cleanup failed", e));
      }
      set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== id);
        let activeTabId = s.activeTabId;
        if (activeTabId === id) {
          const idx = s.tabs.findIndex((t) => t.id === id);
          activeTabId = tabs[Math.max(0, idx - 1)]?.id ?? null;
        }
        return { tabs, activeTabId };
      });
      persist();
    },

    setActiveTab(id) {
      set({ activeTabId: id });
      persist();
    },

    updateTabContent(id, content) {
      const tab = get().tabs.find((t) => t.id === id);
      if (tab?.kind === "settings" || tab?.kind === "files") return; // no content
      // An edit makes a preview tab permanent, so a later sidebar click never replaces unsaved work.
      const changes: Partial<Tab> = { content, isDirty: true, isPreview: false, updatedAt: Date.now() };

      // Auto-derive title from first line for unsaved tabs (like Windows 11 Notepad)
      if (tab && !tab.filePath && tab.kind === "note") {
        const firstLine = content.split("\n")[0]?.trim() ?? "";
        // Strip markdown heading markers (# / ## / ### …)
        const clean = firstLine.replace(/^#+\s*/, "").trim();
        changes.title = clean.slice(0, 60) || "Untitled";
      }

      updateTab(id, changes);
      debounceContentPersist(persist);
    },

    updateTabTitle(id, title) {
      const kind = get().tabs.find((t) => t.id === id)?.kind;
      if (kind === "settings" || kind === "files") return; // not renameable
      updateTab(id, { title, isPreview: false, updatedAt: Date.now() });
      persist();
    },

    updateTabCursor(id, line, column) {
      updateTab(id, { cursorPosition: { line, column } });
    },

    updateTabScroll(id, scrollPosition) {
      updateTab(id, { scrollPosition });
      // Persist (debounced) so the scroll ratio survives an app restart.
      debounceContentPersist(persist);
    },

    updateTabEditorMode(id, mode) {
      updateTab(id, { editorMode: mode });
      persist();
    },

    markTabClean(id) {
      updateTab(id, { isDirty: false });
    },

    addAttachment(id, relativePath, absolutePath) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab) return;
      const next = { ...(tab.attachments ?? {}), [relativePath]: absolutePath };
      updateTab(id, { attachments: next, updatedAt: Date.now() });
      persist();
    },

    togglePinTab(id) {
      set((s) => {
        const toggled = s.tabs.map((t) =>
          t.id === id ? { ...t, isPinned: !t.isPinned, isPreview: false } : t
        );
        // Re-sort: pinned tabs first (preserve relative order within each group)
        const pinned = toggled.filter((t) => t.isPinned);
        const unpinned = toggled.filter((t) => !t.isPinned);
        return { tabs: [...pinned, ...unpinned] };
      });
      persist();
    },

    reorderTabs(tabs) {
      set({ tabs });
      persist();
    },
  };
}
