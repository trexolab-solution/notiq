import { panelWidth } from "./panelWidth";

/** Secure Vault sidebar width (per-device, localStorage like the other prefs). */

export const VAULT_PANEL_KEY = "pref:vaultPanelWidth";
export const VAULT_PANEL_DEFAULT = 248;
/** Header (title + 7 icon buttons) needs ~220px; below this the icons would be pushed out. */
export const VAULT_PANEL_MIN = 240;
export const VAULT_PANEL_MAX = 560;

/** At most half the window, capped, never below the minimum. */
export const vaultPanelWidth = panelWidth({
  key: VAULT_PANEL_KEY,
  min: VAULT_PANEL_MIN,
  def: VAULT_PANEL_DEFAULT,
  step: 10,
  maxFor: (windowWidth) => Math.min(VAULT_PANEL_MAX, windowWidth / 2),
});
