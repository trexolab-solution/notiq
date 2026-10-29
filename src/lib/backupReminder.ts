/** When to nudge the user to back up the vault. Pure logic + tiny localStorage helpers. */

const DAY = 24 * 60 * 60 * 1000;
export const FIRST_BACKUP_AFTER_DAYS = 3;
export const STALE_AFTER_DAYS = 30;
export const SNOOZE_DAYS = 7;

export const KEY_LAST_BACKUP = "pref:vaultLastBackup";
const KEY_SNOOZE = "pref:vaultBackupSnoozedUntil";
const KEY_DISABLED = "pref:vaultBackupNoRemind";
const KEY_FIRST_SEEN = "pref:vaultFirstSeen";

export interface ReminderInput {
  now: number;
  /** ms epoch of the last successful export, or null. */
  lastBackup: number | null;
  /** ms epoch when this device first had a vault, or null if unknown. */
  vaultSince: number | null;
  snoozedUntil: number | null;
  /** The user chose "don't remind me". */
  disabled: boolean;
}

export type ReminderReason = "never" | "stale";

/** Why a reminder is due now, or null when none should show. */
export function backupReminderReason(i: ReminderInput): ReminderReason | null {
  if (i.disabled) return null;
  if (i.snoozedUntil !== null && i.now < i.snoozedUntil) return null;
  if (i.lastBackup === null) {
    return i.vaultSince !== null && i.now - i.vaultSince >= FIRST_BACKUP_AFTER_DAYS * DAY ? "never" : null;
  }
  return i.now - i.lastBackup > STALE_AFTER_DAYS * DAY ? "stale" : null;
}

export const isBackupDue = (i: ReminderInput): boolean => backupReminderReason(i) !== null;

export const snoozeUntil = (now: number): number => now + SNOOZE_DAYS * DAY;

/** "today", "yesterday", "12 days ago". */
export function describeAge(then: number, now: number): string {
  const days = Math.floor((now - then) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

// ─── storage ─────────────────────────────────────────────────────────────────

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
function num(key: string): number | null {
  const raw = read(key);
  const n = Number(raw);
  return raw !== null && Number.isFinite(n) && n > 0 ? n : null;
}

/** Fired after any of the backup preferences change, so banners and Settings stay in sync. */
export const BACKUP_EVENT = "vault:backup-changed";
const changed = () => { try { window.dispatchEvent(new Event(BACKUP_EVENT)); } catch { /* no window */ } };

export const getLastBackup = (): number | null => num(KEY_LAST_BACKUP);
export function recordBackupNow(now = Date.now()) { write(KEY_LAST_BACKUP, String(now)); changed(); }

/** Remembers when the vault first appeared on this device (kept once set). */
export function noteVaultSeen(now = Date.now()) {
  if (num(KEY_FIRST_SEEN) === null) write(KEY_FIRST_SEEN, String(now));
}

export function snoozeBackupReminder(now = Date.now()) { write(KEY_SNOOZE, String(snoozeUntil(now))); changed(); }
export const getBackupReminderDisabled = (): boolean => read(KEY_DISABLED) === "true";
export function setBackupReminderDisabled(v: boolean) { write(KEY_DISABLED, String(v)); changed(); }

export function readReminderInput(now = Date.now()): ReminderInput {
  return {
    now,
    lastBackup: getLastBackup(),
    vaultSince: num(KEY_FIRST_SEEN),
    snoozedUntil: num(KEY_SNOOZE),
    disabled: getBackupReminderDisabled(),
  };
}
