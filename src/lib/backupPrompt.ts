/** Remind the user to back up the vault (sync) until they connect something. */
const KEY_AT = "pref:backupRemindAt";
const KEY_NEVER = "pref:backupNever";
const SNOOZE_MS = 3 * 24 * 3600 * 1000;

const get = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* unavailable */ } };

export const backupDismissedForever = () => get(KEY_NEVER) === "true";
export const snoozeBackupReminder = () => set(KEY_AT, String(Date.now() + SNOOZE_MS));
export const neverRemindBackup = () => set(KEY_NEVER, "true");

/** True when the reminder dialog may be shown now. */
export function backupReminderDue(): boolean {
  if (backupDismissedForever()) return false;
  const at = Number(get(KEY_AT) ?? 0);
  return !Number.isFinite(at) || Date.now() >= at;
}

/** Opens Settings on the given page (handled in App.tsx). */
export const openSettingsAt = (section: "vault" | "ai") =>
  window.dispatchEvent(new CustomEvent("app:open-settings", { detail: section }));
