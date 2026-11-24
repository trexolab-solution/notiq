import { save } from "@tauri-apps/plugin-dialog";
import { BACKUP_EXT, vaultShareExport, type ShareExportArgs } from "./vaultBackup";
import type { VaultItem } from "./vault";

/** The "Share items…" prompt: what the form holds, how it is checked, and how it becomes a `vault_share_export` call. */

export type ValidFor = "1d" | "7d" | "30d" | "never";
export type ItemLife = "1d" | "7d" | "30d" | "forever";

export interface ShareForm {
  /** What was ticked: notes or folders (a folder takes everything in it). */
  paths: string[];
  attachments: boolean;
  /** The password the receiver types. */
  sharePassword: string;
  /** How many times the file can be imported (1 to 100). */
  maxImports: number;
  /** How long the file can be imported. */
  validFor: ValidFor;
  /** How long imported items stay in the receiver's vault. */
  itemLife: ItemLife;
  /** Delete the file after its last import. */
  deleteFile: boolean;
  masterPassword: string;
}

export const MAX_IMPORTS = 100;
export const MIN_SHARE_PASSWORD = 8;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const VALID_FOR_OPTIONS: { value: ValidFor; label: string }[] = [
  { value: "1d", label: "1 day" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "never", label: "No end date" },
];
export const ITEM_LIFE_OPTIONS: { value: ItemLife; label: string }[] = [
  { value: "1d", label: "1 day" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }, { value: "forever", label: "They stay" },
];

/** What the form starts with: one import, a week for the file, a week for the items, the file deleted afterwards. */
export function initialShareForm(paths: string[] = [], password = generateSharePassword()): ShareForm {
  return { paths, attachments: false, sharePassword: password, maxImports: 1, validFor: "7d", itemLife: "7d", deleteFile: true, masterPassword: "" };
}

const DAYS: Record<Exclude<ValidFor, "never">, number> = { "1d": 1, "7d": 7, "30d": 30 };

/** Unix ms when the file stops being importable, or null for no end. */
export function validUntilMs(v: ValidFor, now: number): number | null {
  return v === "never" ? null : now + DAYS[v] * DAY;
}

/** Hours imported items stay, or null for ever. */
export function itemLifeHours(l: ItemLife): number | null {
  return l === "forever" ? null : DAYS[l] * 24;
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

/** The first thing wrong with the form, in words; null when it can be saved. */
export function shareFormProblem(f: ShareForm): string | null {
  if (f.paths.length === 0) return "Choose what to share.";
  if (f.sharePassword.length < MIN_SHARE_PASSWORD) return `The password needs at least ${MIN_SHARE_PASSWORD} characters.`;
  if (f.sharePassword === f.masterPassword) return "Use a different password than your master password.";
  if (!Number.isInteger(f.maxImports) || f.maxImports < 1 || f.maxImports > MAX_IMPORTS) return `It can be imported between 1 and ${MAX_IMPORTS} times.`;
  if (!f.masterPassword) return "Enter your master password.";
  return null;
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
