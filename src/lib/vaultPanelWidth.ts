/** Secure Vault sidebar width: pure clamp + persistence (per-device, localStorage like the other prefs). */

export const VAULT_PANEL_KEY = "pref:vaultPanelWidth";
export const VAULT_PANEL_DEFAULT = 248;
/** Header (title + 7 icon buttons) needs ~220px; below this the icons would be pushed out. */
export const VAULT_PANEL_MIN = 240;
export const VAULT_PANEL_MAX = 560;
export const VAULT_PANEL_STEP = 10;

/** Upper bound for a given window width: half the window, capped, never below the minimum. */
export function maxVaultPanelWidth(windowWidth: number): number {
  const half = Math.floor((Number.isFinite(windowWidth) ? windowWidth : 0) / 2);
  return Math.max(VAULT_PANEL_MIN, Math.min(VAULT_PANEL_MAX, half));
}

export function clampVaultPanelWidth(width: number, windowWidth: number): number {
  const w = Number.isFinite(width) ? Math.round(width) : VAULT_PANEL_DEFAULT;
  return Math.min(maxVaultPanelWidth(windowWidth), Math.max(VAULT_PANEL_MIN, w));
}

export function loadVaultPanelWidth(windowWidth: number): number {
  try {
    const raw = localStorage.getItem(VAULT_PANEL_KEY);
    if (raw === null) return clampVaultPanelWidth(VAULT_PANEL_DEFAULT, windowWidth);
    const n = Number(raw);
    return clampVaultPanelWidth(Number.isFinite(n) ? n : VAULT_PANEL_DEFAULT, windowWidth);
  } catch {
    return clampVaultPanelWidth(VAULT_PANEL_DEFAULT, windowWidth);
  }
}

export function saveVaultPanelWidth(width: number): void {
  try { localStorage.setItem(VAULT_PANEL_KEY, String(Math.round(width))); } catch { /* storage unavailable */ }
}
