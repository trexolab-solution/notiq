import type { EditorMode, TabKind } from "../../types";
import { applyTheme } from "../../lib/themes";
import { normalizeSettingsTabs, SETTINGS_TAB_TITLE, withoutFilesTabs, type SettingsTarget } from "../../lib/tabKinds";
import { makeTab } from "./helpers";
import type { SliceContext } from "./context";
import type { AppState } from "./state";

export type ViewSlice = Pick<
  AppState,
  | "settingsTarget" | "openSettings" | "openRemoteFiles"
  | "pendingJump" | "clearPendingJump" | "navigateToNote"
  | "sessionReady" | "hydrate"
>;

/** Special tabs (Settings, remote files), jumping to a note, and session hydration. */
export function createViewSlice({ set, get, persist }: SliceContext): ViewSlice {
  return {
    // ── settings tab ──────────────────────────────────────────
    settingsTarget: null,

    openSettings(section, settingId) {
      const existing = get().tabs.find((t) => t.kind === "settings");
      const target: SettingsTarget | null = section
        ? { section, settingId, nonce: (get().settingsTarget?.nonce ?? 0) + 1 }
        : get().settingsTarget;
      if (existing) {
        set({ activeTabId: existing.id, settingsTarget: target });
      } else {
        const tab = makeTab({ kind: "settings", title: SETTINGS_TAB_TITLE, editorMode: "preview" });
        set((s) => ({
          tabs: [...s.tabs, tab], activeTabId: tab.id, settingsTarget: target, sessionReady: true,
        }));
      }
      persist();
    },

    // ── remote files tab ──────────────────────────────────────
    openRemoteFiles(target) {
      const existing = get().tabs.find((t) => t.kind === "files" && t.remote?.path === target.path && t.remote.auth === target.auth);
      if (existing) { set({ activeTabId: existing.id }); return; }
      const tab = makeTab({
        kind: "files", title: `Files · ${target.title}`, editorMode: "preview", transient: true,
        remote: { path: target.path, auth: target.auth },
      });
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id, sessionReady: true }));
      persist();
    },

    // ── jump to a note ────────────────────────────────────────
    pendingJump: null,
    clearPendingJump() { set({ pendingJump: null }); },

    navigateToNote(tabId, searchText, line) {
      set((s) => ({
        activeTabId: tabId,
        pendingJump: searchText ? { tabId, searchText, line } : null,
        tabs: s.tabs.map((t) =>
          t.id === tabId && t.editorMode !== "split"
            ? { ...t, editorMode: "split" as EditorMode }
            : t
        ),
      }));
      persist();
    },

    // ── session hydration ─────────────────────────────────────
    sessionReady: false,

    hydrate(tabs, activeTabId, themeId) {
      applyTheme(themeId);
      localStorage.setItem("pref:theme", themeId);
      const migratedTabs = normalizeSettingsTabs(withoutFilesTabs(tabs).map((t) => ({
        ...t,
        kind: (t.kind ?? "note") as TabKind,
        editorMode: t.editorMode === ("rich" as EditorMode) ? "split" as EditorMode : t.editorMode,
        isPinned: t.isPinned ?? false,
      })));
      // An active id that pointed at a dropped duplicate Settings tab falls back to the first tab.
      if (activeTabId && !migratedTabs.some((t) => t.id === activeTabId)
        && tabs.find((t) => t.id === activeTabId)?.kind === "settings") {
        activeTabId = migratedTabs.find((t) => t.kind === "settings")?.id ?? null;
      }
      set({ tabs: migratedTabs, activeTabId, themeId, sessionReady: true });
    },
  };
}
