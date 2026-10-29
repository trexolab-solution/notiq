/** Secure Vault preferences (per-device, kept in localStorage). */
import { DEFAULT_PW_OPTIONS, sanitizePwOptions, type PwOptions } from "./passwordGen";

const KEY_IDLE = "pref:vaultIdleMinutes";
const KEY_HIDE = "pref:vaultLockOnHide";
const KEY_PANIC = "pref:vaultPanicShortcut";
const KEY_DIR = "pref:vaultDir";
const KEY_PW_OPTS = "pref:vaultPwOptions";
const KEY_PW_ASK = "pref:vaultPwAsk";

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

/** User-chosen vault storage folder; null = default (the app-data folder, see vault_default_dir). */
export const getVaultDir = (): string | null => read(KEY_DIR) || null;
export const setVaultDir = (dir: string) => write(KEY_DIR, dir);
export function clearVaultDir() { try { localStorage.removeItem(KEY_DIR); } catch { /* unavailable */ } }

/** Fired after the password-generator preferences change, so the editor and Settings stay in sync. */
export const PW_PREFS_EVENT = "vault:pw-prefs";
const pwChanged = () => window.dispatchEvent(new Event(PW_PREFS_EVENT));

/** Last-used (or saved) password generator options. */
export function getPwOptions(): PwOptions {
  try { return sanitizePwOptions(JSON.parse(read(KEY_PW_OPTS) ?? "null")); } catch { return { ...DEFAULT_PW_OPTIONS }; }
}
export function setPwOptions(o: PwOptions) { write(KEY_PW_OPTS, JSON.stringify(sanitizePwOptions(o))); pwChanged(); }

/** Show the options popup on every "Generate" click. Turned off by "Remember my choice". */
export const getPwAsk = (): boolean => read(KEY_PW_ASK) !== "false";
export const setPwAsk = (v: boolean) => { write(KEY_PW_ASK, String(v)); pwChanged(); };

/** 0.7.0: lock the vault when the OS session locks / the PC sleeps. On by default. */
const KEY_SESSION = "pref:vaultLockOnSession";
export const getLockOnSession = (): boolean => read(KEY_SESSION) !== "false";
export const setLockOnSession = (v: boolean) => write(KEY_SESSION, String(v));

/** 0.7.0: hide revealed secrets (passwords, keys) again after this many seconds; 0 = never. */
const KEY_AUTOHIDE = "pref:vaultAutoHideSeconds";
export const DEFAULT_AUTOHIDE_SECONDS = 30;
export const AUTOHIDE_OPTIONS = [0, 15, 30, 60] as const;
export function parseAutoHideSeconds(raw: string | null): number {
  if (raw === null) return DEFAULT_AUTOHIDE_SECONDS;
  const n = Number(raw);
  return (AUTOHIDE_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_AUTOHIDE_SECONDS;
}
export const getAutoHideSeconds = (): number => parseAutoHideSeconds(read(KEY_AUTOHIDE));
export const setAutoHideSeconds = (n: number) => write(KEY_AUTOHIDE, String(n));
/** Whether a session-lock event should lock the vault right now (pure). */
export const shouldLockOnSession = (prefOn: boolean, unlocked: boolean): boolean => prefOn && unlocked;
