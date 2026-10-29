import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { normalizeCombo } from "../lib/shortcutCombo";

/** Quick search (0.7.0): settings client + the main window's side of the popup. */

export const DEFAULT_QUICK_SEARCH_COMBO = "Ctrl+Alt+K";

export interface QuickSearchStatus {
  enabled: boolean;
  combo: string;
  default_combo: string;
  /** Set when the shortcut couldn't be registered (e.g. another app holds it). */
  error: string | null;
}

/**
 * Why a combo can't be the quick-search hotkey, or null if it can. A system-wide shortcut needs
 * Ctrl, Alt or Cmd (a function key alone would fire while typing in other apps) and must not
 * shadow an in-app shortcut or the panic-lock shortcut. (The backend re-checks the key itself.)
 */
export function quickSearchComboError(
  combo: string,
  appShortcuts: { key: string; label: string }[],
  panicShortcut: string,
): string | null {
  if (!/(^|\+)(Ctrl|Alt|Meta)\+/.test(combo)) return "Use Ctrl, Alt or Cmd with a key";
  const n = normalizeCombo(combo);
  if (n === normalizeCombo(panicShortcut)) return 'Already used by "Panic lock"';
  const clash = appShortcuts.find((s) => normalizeCombo(s.key) === n);
  return clash ? `Already used by "${clash.label}"` : null;
}

export const quickSearchGet =() => invoke<QuickSearchStatus>("quick_search_get");
/** Saves + registers immediately; rejects with a readable message if the shortcut is taken. */
export const quickSearchSet = (enabled: boolean, combo: string) =>
  invoke<QuickSearchStatus>("quick_search_set", { enabled, combo });

/**
 * Main window: react to the popup's "open this entry" (Alt+Enter) and "unlock" requests.
 * After an unlock started from the popup succeeds, the popup is shown again.
 */
export function initQuickSearchBridge() {
  listen<{ rel: string }>("quick-search:open", async (e) => {
    const [{ openEntry }, { resolveVaultDir }] = await Promise.all([
      import("../components/vault/sidebar/actions"),
      import("../lib/vaultDir"),
    ]);
    await openEntry(await resolveVaultDir(), e.payload.rel);
  }).catch((e) => console.warn("quick search: listen failed", e));

  listen("quick-search:unlock", async () => {
    const { useVaultStore } = await import("../store/vaultStore");
    if (await useVaultStore.getState().ensureUnlocked()) {
      await invoke("quick_search_reopen").catch(() => {});
    }
  }).catch((e) => console.warn("quick search: listen failed", e));
}
