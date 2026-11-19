import type { StoreApi } from "zustand";
import { isVaultPath } from "../../lib/vault";
import { saveSession } from "../../lib/session";
import { withoutFilesTabs } from "../../lib/tabKinds";
import type { AppState } from "./state";

/** Builds the session persister: tabs, active tab and theme go to IndexedDB. */
export function createPersist(get: StoreApi<AppState>["getState"]) {
  return () => {
    const { tabs, activeTabId, themeId } = get();
    // Secure Vault: decrypted content must never reach IndexedDB. Persist vault
    // tabs as locked shells; they re-open locked and decrypt from the .nqv file.
    const safeTabs = tabs.map((t) =>
      isVaultPath(t.filePath) ? { ...t, content: "", isDirty: false, vaultLocked: true } : t,
    );
    // A file manager's connection ends with the app, so its tab is not restored (and never the active one).
    const saved = withoutFilesTabs(safeTabs);
    const savedActive = saved.some((t) => t.id === activeTabId) ? activeTabId : (saved[saved.length - 1]?.id ?? null);
    saveSession({ tabs: saved, activeTabId: savedActive, themeId, savedAt: Date.now() });
  };
}
