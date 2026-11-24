import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BACKUP_EXTS } from "./vaultBackup";

/** Importing a share file (vault_share.rs): the file's rules are read once the password opens it. */

/** One item of a share file, by name (never its content). */
export interface ShareItem {
  /** The path inside the vault (`Work/bank.nqv`); a folder has no suffix. */
  path: string;
  /** The type of note ("login", "ssh", "md", …); empty for a folder. */
  ext: string;
  dir: boolean;
  attachments: number;
}

/** What the import prompt shows once the file is open (`vault_share_inspect`). */
export interface ShareInfo {
  /** What is in it, in path order. */
  items: ShareItem[];
  notes: number;
  folders: number;
  attachments: number;
  /** Unix ms; the file can't be imported after it. */
  validUntil: number | null;
  /** Imported items destroy themselves this long after the import (ms). */
  itemLifeMs: number | null;
  /** Or at this moment (Unix ms), whenever they were imported. */
  itemUntil: number | null;
  /** The file is deleted after its last import. */
  deleteFile: boolean;
  /** A share only goes into a vault that exists and is open. */
  vault: "none" | "locked" | "ready";
  /** Imports left (only known while the vault is open). */
  importsLeft: number | null;
  /** Why it can't be imported now; only checked while the vault is open. */
  problem: ShareProblemCode | null;
}

export type ShareProblemCode = "expired" | "noImportsLeft" | "clockBehind" | "itemsEnded";

export interface ShareImportResult {
  added: number;
  already: number;
  expired: number;
  importsLeft: number;
  /** Unix ms when the added items destroy themselves. */
  expiresAt: number | null;
  fileDeleted: boolean;
  /** The file should have been deleted but couldn't be. */
  deleteFailed: boolean;
}

export const vaultShareInspect = (path: string, password: string) => invoke<ShareInfo>("vault_share_inspect", { path, password });
export const vaultShareImport = (path: string, password: string) => invoke<ShareImportResult>("vault_share_import", { path, password });

export async function pickShareFile(): Promise<string | null> {
  const sel = await open({
    title: "Choose a Notiq share file",
    multiple: false,
    filters: [{ name: "Notiq file", extensions: [...BACKUP_EXTS] }],
  });
  return typeof sel === "string" ? sel : null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The items with the folders above them added where the share has no entry of its own for one (a folder that exists
 * only because notes sit in it), so every note shows under its folder. In path order, a folder before what is in it.
 */
export function withFolders(items: readonly ShareItem[]): ShareItem[] {
  const have = new Set(items.filter((i) => i.dir).map((i) => i.path));
  const extra: ShareItem[] = [];
  for (const i of items) {
    const parts = i.path.split("/");
    for (let n = 1; n < parts.length; n++) {
      const dir = parts.slice(0, n).join("/");
      if (!have.has(dir)) { have.add(dir); extra.push({ path: dir, ext: "", dir: true, attachments: 0 }); }
    }
  }
  return [...items, ...extra].sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()) || a.path.localeCompare(b.path));
}

/** "7 days", "1 day", "5 hours", "1 hour" (item lives are whole hours; whole days are named in days). */
export function formatLife(ms: number): string {
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return hours % 24 === 0 ? plural(hours / 24, "day") : plural(hours, "hour");
}

/** "3 Dec, 14:20" in the user's locale. */
export function formatWhen(ms: number, locale?: string): string {
  return new Date(ms).toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Why a file can't be imported, in words. */
export function problemText(code: ShareProblemCode): string {
  switch (code) {
    case "expired": return "This share file has expired.";
    case "noImportsLeft": return "This share file can't be imported again.";
    case "clockBehind": return "The date and time on this PC are behind. Fix them, then try again.";
    case "itemsEnded": return "The time these items were to be removed has already passed.";
  }
}

/**
 * The few short lines the prompt shows next to the Import button, in plain words (a privacy-note style): when the
 * items go, how many imports are left, and that the file is deleted. Nothing is said about what is not set.
 */
export function shareNoteLines(info: ShareInfo, now: number): string[] {
  const lines: string[] = [];
  if (info.itemUntil != null) {
    lines.push(`These items will be removed from your vault on ${formatWhen(info.itemUntil)}.`);
  } else if (info.itemLifeMs != null) {
    lines.push(`These items will be removed from your vault on ${formatWhen(now + info.itemLifeMs)} (in ${formatLife(info.itemLifeMs)}).`);
  }
  if (info.importsLeft != null) {
    lines.push(`This file can be imported ${plural(info.importsLeft, "more time")}.`);
  }
  if (info.deleteFile) {
    lines.push(info.importsLeft === 1
      ? "After this import, the file is deleted from this computer."
      : "After the last import, the file is deleted from this computer.");
  }
  return lines;
}

/** What the toast says after an import. */
export function importSummary(r: ShareImportResult): string {
  if (r.added > 0) {
    const when = r.expiresAt != null ? ` They are removed on ${formatWhen(r.expiresAt)}.` : "";
    return `Imported ${plural(r.added, "note")}.${when}`;
  }
  if (r.expired > 0) return "Nothing was imported: these items have already been removed.";
  return "Nothing new to import: these notes are already in your vault.";
}
