import { save } from "@tauri-apps/plugin-dialog";
import { BACKUP_EXT, vaultShareExport, type ShareExportArgs } from "./vaultBackup";
import type { VaultItem } from "./vault";

/** The "Share items…" prompt: what the form holds, how it is checked, and how it becomes a `vault_share_export` call. */

export type TimeUnit = "hours" | "days";

/** A length of time the sender sets (or turns off): "7 days", "36 hours", or none. */
export interface TimeLimit {
  /** Off = no end (the file) or the items stay (the items). */
  on: boolean;
  amount: number;
  unit: TimeUnit;
}

export interface ShareForm {
  /** What was ticked: notes or folders (a folder takes everything in it). */
  paths: string[];
  attachments: boolean;
  /** The password the receiver types. */
  sharePassword: string;
  /** How many times the file can be imported (1 to 100). */
  maxImports: number;
  /** How long the file can be imported. */
  validFor: TimeLimit;
  /** How long imported items stay in the receiver's vault. */
  itemLife: TimeLimit;
  /** Delete the file after its last import. */
  deleteFile: boolean;
  masterPassword: string;
}

export const MAX_IMPORTS = 100;
export const MIN_SHARE_PASSWORD = 8;
/** The longest either time can be: a year. */
export const MAX_LIMIT_HOURS = 365 * 24;
const HOUR = 3_600_000;

/** How the two limits are named in their error messages. */
export const FILE_EXPIRY = "File expiry";
export const ITEM_REMOVAL = "Item removal";

export const UNIT_OPTIONS: { value: TimeUnit; label: string }[] = [{ value: "hours", label: "hours" }, { value: "days", label: "days" }];

/** What the form starts with: one import, a week for the file, a week for the items, the file deleted afterwards. */
export function initialShareForm(paths: string[] = [], password = generateSharePassword()): ShareForm {
  return {
    paths, attachments: false, sharePassword: password, maxImports: 1,
    validFor: { on: true, amount: 7, unit: "days" }, itemLife: { on: true, amount: 7, unit: "days" },
    deleteFile: true, masterPassword: "",
  };
}

/** The length of a limit in hours (0 when it is off). */
export function limitHours(l: TimeLimit): number {
  return l.on ? l.amount * (l.unit === "days" ? 24 : 1) : 0;
}

/** The most a limit can be in `unit`: a year. */
export function limitMax(unit: TimeUnit): number {
  return unit === "days" ? MAX_LIMIT_HOURS / 24 : MAX_LIMIT_HOURS;
}

/** What is wrong with a limit, in words (`what` names it: "File expiry"); null when it is fine or off. */
export function limitProblem(l: TimeLimit, what: string): string | null {
  if (!l.on) return null;
  if (!Number.isInteger(l.amount) || l.amount < 1 || l.amount > limitMax(l.unit)) return `${what}: enter 1 to ${limitMax(l.unit)} ${l.unit}.`;
  return null;
}

/** Unix ms when the file stops being importable, or null for no end. */
export function validUntilMs(l: TimeLimit, now: number): number | null {
  return l.on ? now + limitHours(l) * HOUR : null;
}

/** Hours imported items stay, or null for ever. */
export function itemLifeHours(l: TimeLimit): number | null {
  return l.on ? limitHours(l) : null;
}

/** "7 days", "1 day", "36 hours", "1 hour". */
export function describeLimit(l: TimeLimit): string {
  const n = l.amount;
  return `${n} ${l.unit === "days" ? (n === 1 ? "day" : "days") : (n === 1 ? "hour" : "hours")}`;
}

/**
 * A password for the receiver: 20 characters from an alphabet without look-alikes, in groups of five
 * ("k7mqx-4tnhd-wc9ra-p2vze"), about 100 bits. Typed once on the other side, so it is made easy to read out.
 */
export function generateSharePassword(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no i, l, o, 0, 1
  const out: string[] = [];
  let bytes = random(40);
  let i = 0;
  while (out.length < 20) {
    if (i >= bytes.length) { bytes = random(40); i = 0; }
    const b = bytes[i++];
    if (b >= 248) continue; // keeps every character equally likely (248 = 8 * 31)
    out.push(alphabet[b % alphabet.length]);
  }
  return out.join("").replace(/(.{5})(?=.)/g, "$1-");
}

/** The paths that really are chosen: a path under a ticked folder is already covered. */
export function coveredBy(paths: readonly string[], rel: string): string | null {
  for (const p of paths) {
    if (p !== rel && rel.startsWith(`${p}/`)) return p;
  }
  return null;
}

/** Ticks or unticks `rel`; ticking a folder drops the paths under it, which it now covers. */
export function toggleChosen(paths: readonly string[], rel: string, on: boolean): string[] {
  if (!on) return paths.filter((p) => p !== rel);
  if (paths.includes(rel) || coveredBy(paths, rel)) return [...paths];
  return [...paths.filter((p) => !p.startsWith(`${rel}/`)), rel];
}

/** The vault's items as the list the dialog shows (folders first within their parent, by path), deepest last. */
export function listForShare(items: readonly VaultItem[], query: string): VaultItem[] {
  const q = query.trim().toLowerCase();
  const kept = items.filter((i) => i.trashed_at == null);
  const shown = q ? kept.filter((i) => i.rel.toLowerCase().includes(q)) : kept;
  return [...shown].sort((a, b) => a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));
}

/** Step "Items": something has to be chosen. */
export function itemsProblem(f: ShareForm): string | null {
  return f.paths.length === 0 ? "Choose what to share." : null;
}

/** What is wrong with the number of imports; null when it is fine. */
export function importsProblem(n: number): string | null {
  return Number.isInteger(n) && n >= 1 && n <= MAX_IMPORTS ? null : `Number of imports: enter 1 to ${MAX_IMPORTS}.`;
}

/** The receiver's password: long enough; null when it is fine. */
export function passwordProblem(p: string): string | null {
  return p.length >= MIN_SHARE_PASSWORD ? null : `The password needs at least ${MIN_SHARE_PASSWORD} characters.`;
}

/** Step "Rules": the password, how often, and the two time limits. */
export function rulesProblem(f: ShareForm): string | null {
  return passwordProblem(f.sharePassword) ?? importsProblem(f.maxImports) ?? limitProblem(f.validFor, FILE_EXPIRY) ?? limitProblem(f.itemLife, ITEM_REMOVAL);
}

/** Step "Confirm": the master password, and not the same as the receiver's. */
export function confirmProblem(f: ShareForm): string | null {
  if (f.sharePassword === f.masterPassword) return "Use a different password than your master password.";
  if (!f.masterPassword) return "Enter your master password.";
  return null;
}

/** The first thing wrong with the form, in words; null when it can be saved. */
export function shareFormProblem(f: ShareForm): string | null {
  return itemsProblem(f) ?? rulesProblem(f) ?? confirmProblem(f);
}

/** The short summary the last step shows: what is shared and the rules, in plain words. */
export function shareSummary(f: ShareForm, preview: { notes: number; folders: number; attachments: number } | null, now: number): string[] {
  const out: string[] = [];
  if (preview) {
    const n = (c: number, one: string, many = `${one}s`) => `${c} ${c === 1 ? one : many}`;
    out.push(`${n(preview.notes, "note")}${preview.folders > 0 ? `, ${n(preview.folders, "folder")}` : ""}${f.attachments && preview.attachments > 0 ? `, ${n(preview.attachments, "attachment")}` : ""}`);
  }
  out.push(`Can be imported ${f.maxImports} ${f.maxImports === 1 ? "time" : "times"}`);
  const until = validUntilMs(f.validFor, now);
  out.push(until == null ? "The file never expires" : `The file expires after ${describeLimit(f.validFor)}`);
  out.push(f.itemLife.on ? `Items are removed ${describeLimit(f.itemLife)} after the import` : "Items are never removed");
  out.push(f.deleteFile ? "The file is deleted after its last import" : "The file is kept after its last import");
  return out;
}

/** The call `vault_share_export` takes for this form and the chosen file. */
export function toExportArgs(f: ShareForm, destPath: string, now: number): ShareExportArgs {
  return {
    paths: f.paths,
    attachments: f.attachments,
    masterPassword: f.masterPassword,
    sharePassword: f.sharePassword,
    maxImports: f.maxImports,
    validUntilMs: validUntilMs(f.validFor, now),
    itemLifeHours: itemLifeHours(f.itemLife),
    deleteFile: f.deleteFile,
    destPath,
  };
}

/** "notiq-share-2026-11-24.nqb" (local date). */
export function defaultShareName(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `notiq-share-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.${BACKUP_EXT}`;
}

/** Asks where to save, then writes the share file. Null when the save dialog was cancelled. */
export async function exportShareWithDialog(f: ShareForm, now = Date.now()): Promise<{ path: string; bytes: number; notes: number } | null> {
  const dest = await save({
    title: "Save share file",
    defaultPath: defaultShareName(),
    filters: [{ name: "Notiq share file", extensions: [BACKUP_EXT] }],
  });
  if (!dest) return null;
  const path = dest.toLowerCase().endsWith(`.${BACKUP_EXT}`) ? dest : `${dest}.${BACKUP_EXT}`;
  const res = await vaultShareExport(toExportArgs(f, path, now));
  return { path, ...res };
}
