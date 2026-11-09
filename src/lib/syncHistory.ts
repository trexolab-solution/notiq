import { invoke } from "@tauri-apps/api/core";

/**
 * Vault Sync version history ("Restore vault from a date"). The backend keeps a daily copy of every
 * device's encrypted snapshot in Google Drive for 30 days (plus checkpoints taken before risky
 * operations); restoring one merges it into this vault: items from that date come back, nothing
 * here is removed, and a backup is made first. See src-tauri/src/sync/history.rs.
 */

/** One restore point. `id` is opaque: pass it back to restore, never show it. */
export interface RestorePoint {
  id: string;
  /** UTC date, `yyyy-mm-dd`. */
  date: string;
  /** When the copy was taken / stored (Unix ms), when known. */
  takenMs: number | null;
  /** Empty when unknown (shown as "Unnamed device"), never an id. */
  deviceName: string;
  thisDevice: boolean;
  size: number;
  kind: "daily" | "checkpoint";
}

export interface RestoreSummary {
  added: number;
  updated: number;
  unchanged: number;
  keptInHistory: number;
  attachmentsMissing: number;
  backupPath: string | null;
  date: string;
}

export const syncHistoryList = () => invoke<RestorePoint[]>("sync_history_list");
export const syncHistoryRestore = (point: string) => invoke<RestoreSummary>("sync_history_restore", { point });

/** How many days of daily copies Drive keeps (mirrors `history::KEEP_DAYS`). */
export const HISTORY_KEEP_DAYS = 30;

export interface RestoreDateGroup { date: string; label: string; points: RestorePoint[] }

/** "Monday, 9 November 2026" for a `yyyy-mm-dd` UTC date (the date the copy belongs to). */
export function formatRestoreDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
  });
}

/** Points grouped by date, newest date first; within a date this PC first, then by name. */
export function groupRestorePoints(points: RestorePoint[]): RestoreDateGroup[] {
  const by = new Map<string, RestorePoint[]>();
  for (const p of points) {
    const list = by.get(p.date) ?? [];
    list.push(p);
    by.set(p.date, list);
  }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => ({
      date,
      label: formatRestoreDate(date),
      points: [...list].sort((a, b) =>
        Number(b.thisDevice) - Number(a.thisDevice)
        || a.deviceName.localeCompare(b.deviceName)
        || (b.takenMs ?? 0) - (a.takenMs ?? 0)),
    }));
}

/** "1.2 MB" / "340 KB". */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const notes = (n: number) => (n === 1 ? "1 note" : `${n} notes`);

/** The result text after a restore (also the toast). */
export function describeRestore(s: RestoreSummary): string {
  const parts: string[] = [];
  if (s.added) parts.push(`${notes(s.added)} came back`);
  if (s.updated) parts.push(`${notes(s.updated)} updated`);
  let text = parts.length ? `${parts.join(", ")}.` : "Nothing was missing: your vault already had everything from that date.";
  if (s.keptInHistory) {
    text += ` ${notes(s.keptInHistory)} changed since then kept ${s.keptInHistory === 1 ? "its" : "their"} newer text; the restored version is in ${s.keptInHistory === 1 ? "its" : "their"} history.`;
  }
  if (s.attachmentsMissing) {
    text += ` ${s.attachmentsMissing === 1 ? "1 attachment wasn't" : `${s.attachmentsMissing} attachments weren't`} in your Drive anymore and couldn't be restored.`;
  }
  return text;
}
