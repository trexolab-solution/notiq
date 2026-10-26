/** Secure Vault preferences (per-device, kept in localStorage). */

const KEY_IDLE = "pref:vaultIdleMinutes";
const KEY_HIDE = "pref:vaultLockOnHide";
const KEY_PANIC = "pref:vaultPanicShortcut";
const KEY_DIR = "pref:vaultDir";

export const DEFAULT_IDLE_MINUTES = 5;
/** Selectable auto-lock timeouts in minutes; 0 = never. */
export const IDLE_OPTIONS = [0, 1, 5, 15, 30, 60] as const;

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

export function getIdleMinutes(): number {
  const raw = read(KEY_IDLE);
  if (raw === null) return DEFAULT_IDLE_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MINUTES;
}
export const setIdleMinutes = (n: number) => write(KEY_IDLE, String(n));

/** Lock when the window is closed to the tray. On by default. */
export const getLockOnHide = (): boolean => read(KEY_HIDE) !== "false";
export const setLockOnHide = (v: boolean) => write(KEY_HIDE, String(v));

/** Panic-lock shortcut as a canonical combo ("Ctrl+Alt+L"). */
export const DEFAULT_PANIC_SHORTCUT = "Ctrl+Alt+L";
export const getPanicShortcut = (): string => read(KEY_PANIC) || DEFAULT_PANIC_SHORTCUT;
export const setPanicShortcut = (combo: string) => write(KEY_PANIC, combo);

/** User-chosen vault storage folder; null = default (Documents/Notiq Vault). */
export const getVaultDir = (): string | null => read(KEY_DIR) || null;
export const setVaultDir = (dir: string) => write(KEY_DIR, dir);
export function clearVaultDir() { try { localStorage.removeItem(KEY_DIR); } catch { /* unavailable */ } }
