/**
 * Vault Sync setup (0.9.0) — the ONE decision "what comes next after Google sign-in", plus the copy of the
 * screens and toasts it leads to. Pure functions only; the effects live in ./syncSetupFlow.
 * Spec: design/vault-sync-ux-flow.md → "The decision after sign-in".
 */
import { relativeTime, type RemoteVaultInfo, type SyncDevice, type SyncResult, type SyncStatus } from "./vaultSync";

/** Window event that starts the setup flow (title bar / status bar popover "Connect Google Drive"). */
export const SYNC_START_SETUP_EVENT = "notiq:sync-start-setup";

/** What this PC has. `items` = entries in the local vault (null when it couldn't be read, e.g. locked). */
export interface LocalVaultFacts { exists: boolean; unlocked: boolean; items: number | null }

export type NextStep =
  /** Rows 1 and 3: only the Drive vault's master password. `replaceLocal`: an empty local vault is replaced (backup kept). */
  | { kind: "openDrive"; replaceLocal: boolean }
  /** Row 2: create the vault here; sync turns on once it exists. */
  | { kind: "create" }
  /** Rows 3–6 need the local vault's key: unlock first, then decide again. */
  | { kind: "unlock" }
  /** Row 4: one confirm ("Upload this vault (N items) to Google Drive?"). */
  | { kind: "upload"; items: number | null }
  /**
   * Row 7: resuming on a PC that synced before, and Drive is empty (the Drive vault was deleted): ask
   * "Upload this PC's vault (N items) again?". Never uploaded without that answer, also not with `autoUpload`.
   */
  | { kind: "reupload"; items: number | null }
  /** Row 5: nothing to ask, merge and turn on. */
  | { kind: "merge" }
  /** Row 6: the two-vaults dialog. */
  | { kind: "twoVaults"; items: number | null };

/** What the decision needs besides the two vaults. */
export interface SetupContext {
  /** This PC synced before and sync is paused / off now: turning it on is a resume (see `wasSyncedBefore`). */
  wasSynced?: boolean;
}

/** A resume: sync is not on here, but this PC has synced before (so an empty Drive means the Drive vault went away). */
export const wasSyncedBefore = (s: Pick<SyncStatus, "enabled" | "lastSyncedMs"> | null | undefined): boolean =>
  !!s && !s.enabled && s.lastSyncedMs != null;

/** The decision after sign-in (every row of the table is unit-tested). */
export function decideAfterSignIn(local: LocalVaultFacts, remote: RemoteVaultInfo, ctx: SetupContext = {}): NextStep {
  if (!local.exists) return remote.exists ? { kind: "openDrive", replaceLocal: false } : { kind: "create" };
  // Everything below reads or merges the local vault, which needs its key.
  if (!local.unlocked) return { kind: "unlock" };
  if (!remote.exists) return ctx.wasSynced ? { kind: "reupload", items: local.items } : { kind: "upload", items: local.items };
  if (remote.sameVault === true) return { kind: "merge" };
  // A different Drive vault: an empty local vault has nothing to keep, so open the Drive vault directly.
  if (local.items === 0) return { kind: "openDrive", replaceLocal: true };
  return { kind: "twoVaults", items: local.items };
}

// ── Facts about the Drive vault that need no key ─────────────────────────────

/** A device name that is a real name, not the raw id the backend falls back to. */
const realName = (d: SyncDevice) => (d.name && d.name !== d.id ? d.name : null);

/**
 * "last changed on LAPTOP, 2 hours ago" from the devices list (works without the vault key): the other device
 * seen most recently. The name is left out when only an id is known; null when nothing is known.
 */
export function lastChangedText(devices: SyncDevice[] | null | undefined, now = Date.now()): string | null {
  const others = (devices ?? []).filter((d) => !d.thisDevice && d.lastSeenMs != null);
  if (!others.length) return null;
  const latest = others.reduce((a, b) => ((b.lastSeenMs ?? 0) > (a.lastSeenMs ?? 0) ? b : a));
  const when = relativeTime(latest.lastSeenMs, now);
  const name = realName(latest);
  return name ? `last changed on ${name}, ${when}` : `last changed ${when}`;
}

/** The name of the device the Drive vault came from (for "Vault ready · synced with LAPTOP"), or null. */
export function sourceDeviceName(devices: SyncDevice[] | null | undefined): string | null {
  const others = (devices ?? []).filter((d) => !d.thisDevice);
  if (!others.length) return null;
  const latest = others.reduce((a, b) => ((b.lastSeenMs ?? 0) > (a.lastSeenMs ?? 0) ? b : a));
  return realName(latest);
}

// ── Copy ─────────────────────────────────────────────────────────────────────

export const itemsText = (n: number) => (n === 1 ? "1 item" : `${n} items`);

/** "Upload this vault (12 items) to Google Drive?" */
export const uploadQuestion = (items: number | null) =>
  items == null ? "Upload this vault to Google Drive?" : `Upload this vault (${itemsText(items)}) to Google Drive?`;

/** Row 7's dialog title. */
export const REUPLOAD_TITLE = "Vault not found in Google Drive";

/** "Your vault wasn't found in Google Drive (it may have been deleted). Upload this PC's vault (42 items) again?" */
export const reuploadQuestion = (items: number | null) =>
  `Your vault wasn't found in Google Drive (it may have been deleted). Upload this PC's vault${items == null ? "" : ` (${itemsText(items)})`} again?`;

/** Toast when an upload question is answered with Cancel / Not now: sync stays paused here. */
export const PAUSED_TOAST = "Sync is paused on this PC. Resume it any time in Settings → Sync.";

/** Toast after "Keep this PC separate". */
export const KEPT_SEPARATE_TOAST = "Sync is paused on this PC. It keeps its own vault.";

/** "Vault ready · synced with LAPTOP" after opening the Drive vault. */
export const vaultReadyMessage = (device: string | null) =>
  `Vault ready · synced with ${device ?? "Google Drive"}`;

/** "Synced · 3 changes" after the silent merge (same vault already in Drive). */
export function mergedMessage(r: SyncResult): string {
  const n = r.added + r.updated + r.removed;
  return n === 0 ? "Synced · up to date" : `Synced · ${n === 1 ? "1 change" : `${n} changes`}`;
}

/** Toast after the two-vaults dialog. */
export function twoVaultsDoneMessage(mode: "import" | "backupOnly", imported: number): string {
  return mode === "import" ? `Vault ready · ${itemsText(imported)} added` : "Vault ready · using the Google Drive vault";
}

/** Where the backup goes, said before Continue (the exact file name is only known afterwards). */
export const BACKUP_BEFORE_TEXT =
  "A backup of this PC's vault is saved first, in the vault-sync-backups folder in Notiq's app data. The exact file is shown when it's done.";

export const NO_DRIVE_VAULT_TEXT = "No vault in this Google Drive yet";
