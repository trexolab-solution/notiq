import type { Tab } from "../../types";
import { isVaultPath } from "../../lib/vault";
import { scrubMonacoModels } from "../../lib/vaultMemory";
import { planVaultOpen } from "../../lib/vaultTabs";
import { useVaultStore } from "../vaultStore";
import { makeTab } from "./helpers";
import type { SliceContext } from "./context";
import type { AppState } from "./state";

export type FileSlice = Pick<
  AppState,
  | "saveTabToFile" | "saveTabToFileAs" | "openFilesAsTabs" | "openVaultEntry" | "makeTabPermanent" | "reloadTabFromDisk"
>;

/** File I/O: save, open files and vault entries as tabs, reload from disk. */
export function createFileSlice({ set, get, persist, updateTab, saveTabImpl }: SliceContext): FileSlice {
  return {
    saveTabToFile: (id) => saveTabImpl(id, false),
    saveTabToFileAs: (id) => saveTabImpl(id, true),

    openFilesAsTabs(files) {
      if (files.length === 0) return;
      const { defaultEditorMode, tabs } = get();

      // Map normalized path → existing tab id so a file that's already open is
      // re-focused instead of opened twice. Paths arrive from several sources
      // (file dialog, drag-drop, OS file-association, second-instance) with
      // mixed separators and casing, so compare on a canonical key.
      const norm = (p?: string) => (p ? p.replace(/\\/g, "/").toLowerCase() : "");
      const byPath = new Map<string, string>();
      for (const t of tabs) {
        if (t.filePath) byPath.set(norm(t.filePath), t.id);
      }

      const newTabs: Tab[] = [];
      let focusId: string | null = null;
      for (const { path, content, title } of files) {
        const filePath = path.replace(/\\/g, "/");
        const key = norm(filePath);
        const existingId = byPath.get(key);
        if (existingId) {
          // Already open (or a duplicate within this same batch) — just focus it.
          focusId = existingId;
          continue;
        }
        const tab = isVaultPath(filePath)
          // Ciphertext is never read into a tab; it opens locked and decrypts on unlock.
          ? makeTab({ title, content: "", filePath, isDirty: false, editorMode: defaultEditorMode, vaultLocked: true })
          : makeTab({ title, content, filePath, isDirty: false, editorMode: defaultEditorMode });
        newTabs.push(tab);
        byPath.set(key, tab.id);
        focusId = tab.id;
      }

      if (newTabs.length === 0) {
        // Every requested file is already open — restore focus to the last one.
        if (focusId && focusId !== get().activeTabId) {
          set({ activeTabId: focusId });
          persist();
        }
        return;
      }

      set((s) => ({
        tabs:        [...s.tabs, ...newTabs],
        activeTabId: focusId ?? newTabs[newTabs.length - 1].id,
      }));
      persist();
      // Vault already unlocked this session → decrypt the newly opened tabs now.
      if (newTabs.some((t) => t.vaultLocked) && useVaultStore.getState().unlocked) {
        void get().unlockVaultTabs();
      }
    },

    openVaultEntry({ path, title }, mode) {
      const filePath = path.replace(/\\/g, "/");
      const plan = planVaultOpen(get().tabs, filePath, mode);
      if (plan.action === "focus") {
        set((s) => ({
          activeTabId: plan.tabId,
          tabs: plan.promote ? s.tabs.map((t) => (t.id === plan.tabId ? { ...t, isPreview: false } : t)) : s.tabs,
        }));
        persist();
        return;
      }
      // Ciphertext is never read into a tab; it opens locked and decrypts below.
      const tab = makeTab({
        title, content: "", filePath, isDirty: false, editorMode: get().defaultEditorMode, vaultLocked: true,
        isPreview: plan.action === "replace" || plan.preview,
      });
      if (plan.action === "replace") {
        // The old preview tab is clean (planVaultOpen checks), so nothing is lost. A fresh tab id
        // gives the new entry clean editor state; the old one's decrypted text is scrubbed.
        const oldId = plan.tabId;
        set((s) => ({ tabs: s.tabs.map((t) => (t.id === oldId ? tab : t)), activeTabId: tab.id }));
        setTimeout(() => void scrubMonacoModels([oldId]), 100);
      } else {
        set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, sessionReady: true }));
      }
      persist();
      if (useVaultStore.getState().unlocked) void get().unlockVaultTabs();
    },

    makeTabPermanent(id) {
      if (!get().tabs.find((t) => t.id === id)?.isPreview) return;
      updateTab(id, { isPreview: false });
      persist();
    },

    reloadTabFromDisk(id, content) {
      const tab = get().tabs.find((t) => t.id === id);
      if (!tab || tab.content === content) return;
      // External edit picked up by the file watcher — adopt disk content and
      // keep the tab clean (it now matches what's on disk, like Notepad++).
      updateTab(id, { content, isDirty: false, updatedAt: Date.now() });
      persist();
    },
  };
}
