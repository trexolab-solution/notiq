/**
 * Vault Sync lifecycle feedback + onboarding gates (0.9.0) — the pure decisions behind:
 *  • first upload ("Uploading your vault… N entries" → "Your vault is now in Google Drive"),
 *  • the single "Google needs you to sign in again" notification,
 *  • "New device: <name> joined your vault" (once per device),
 *  • the post-create "Use this vault on your other PCs?" step, the one-time vault-panel banner and the
 *    indicator tip hand-off to the status-bar indicator.
 *
 * Flags are standalone `localStorage` (same pattern as `lib/firstRun.ts`), NOT the preferences registry,
 * so Settings → "Reset Preferences" never re-shows a one-time banner or re-announces old devices.
 * Every storage access is wrapped: a private window / blocked storage just means "don't nag".
 */
import type { RemoteVaultInfo, SyncDevice, SyncStatus } from "./vaultSync";

// ── Storage keys (shared with sync-ux-surfaces: INDICATOR_TIP_KEY) ───────────

/** "pending" → the status-bar indicator shows its one-time tip; the indicator sets "shown". */
export const INDICATOR_TIP_KEY = "notiq.sync.indicatorTip";
/** "done" once the vault-panel "New: sync your vault across PCs" banner was dismissed or used. */
export const SYNC_BANNER_KEY = "notiq.sync.banner";
/** JSON string[] of device ids already known for one synced vault (keyed by Google account). */
export const SEEN_DEVICES_PREFIX = "notiq.sync.seenDevices:";
/** Window event the sync popover (status bar) listens for. */
export const OPEN_SYNC_POPOVER_EVENT = "notiq:open-sync-popover";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable: ignore */ }
}

// ── First upload ──────────────────────────────────────────────────────────────

/**
 * True when turning sync on will upload this vault for the first time (Drive holds no vault yet).
 * Unknown (the remote check failed) → false: the caller shows the generic "Turning on sync…" feedback.
 */
export const isFirstUpload = (remote: RemoteVaultInfo | null | undefined): boolean => !!remote && !remote.exists;

/** Entries counted for the upload message: notes, not folders. */
export const countEntries = (items: { dir: boolean }[] | null | undefined): number | null =>
  items ? items.filter((i) => !i.dir).length : null;

/** "Uploading your vault… 12 entries" (no count when the list couldn't be read). */
export function uploadingMessage(entries: number | null): string {
  if (entries == null) return "Uploading your vault…";
  return `Uploading your vault… ${entries} ${entries === 1 ? "entry" : "entries"}`;
}

export const FIRST_UPLOAD_DONE = "Your vault is now in Google Drive";

// ── "Sign in again" notify-once ──────────────────────────────────────────────

export type AuthNeededAction = "notify" | "clear" | null;

/**
 * Follows the status stream and says when to show / take down the reconnect notification:
 * "notify" once when sync enters `authNeeded`, nothing on the repeated status events while it stays
 * there, "clear" when it leaves (so a later expiry notifies again).
 */
export function createAuthNeededTracker() {
  let active = false;
  return (s: SyncStatus | null): AuthNeededAction => {
    const now = !!s && s.state === "authNeeded";
    if (now === active) return null;
    active = now;
    return now ? "notify" : "clear";
  };
}

// ── New devices ──────────────────────────────────────────────────────────────

/** The seen-set key for one synced vault. Drive's app folder holds one vault per Google account. */
export const seenDevicesKey = (account: string | null | undefined) =>
  `${SEEN_DEVICES_PREFIX}${(account ?? "").trim().toLowerCase() || "default"}`;

export function loadSeenDevices(key: string): string[] | null {
  const raw = read(key);
  if (raw == null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}
export const saveSeenDevices = (key: string, ids: string[]) => write(key, JSON.stringify(ids));

/**
 * Which devices to announce, and the seen set to store. The first load ever (`seen === null`) seeds the
 * set silently; this device is never announced. The set only grows, so a device is announced at most once.
 */
export function diffNewDevices(seen: string[] | null, devices: SyncDevice[]): { added: SyncDevice[]; seen: string[] } {
  const known = new Set(seen ?? []);
  const added = seen === null ? [] : devices.filter((d) => !d.thisDevice && !known.has(d.id));
  for (const d of devices) known.add(d.id);
  return { added, seen: [...known] };
}

export const newDeviceMessage = (name: string) => `New device: ${name || "another PC"} joined your vault`;

// ── Onboarding / banner / tip gates ──────────────────────────────────────────

/** Offer "Use this vault on your other PCs?" after creating a vault: only when Google sign-in exists in this build. */
export const shouldOfferSyncOnboarding = (s: SyncStatus | null): boolean => !!s?.configured && !s.enabled;

export const isSyncBannerDone = (): boolean => read(SYNC_BANNER_KEY) !== null || storageBlocked();
export const markSyncBannerDone = () => write(SYNC_BANNER_KEY, "done");

/** Existing vault, sync available but off, banner not yet dismissed/used. */
export function shouldShowSyncBanner(input: { exists: boolean; status: SyncStatus | null; done: boolean }): boolean {
  const { exists, status, done } = input;
  return exists && !done && !!status?.configured && !status.enabled;
}

/** "Not now" on the post-create step: the indicator shows its tip once (unless it already did). */
export function setIndicatorTipPending(): void {
  if (read(INDICATOR_TIP_KEY) === "shown") return;
  write(INDICATOR_TIP_KEY, "pending");
}
export const getIndicatorTip = () => read(INDICATOR_TIP_KEY);

export const openSyncPopover = () => window.dispatchEvent(new CustomEvent(OPEN_SYNC_POPOVER_EVENT));

function storageBlocked(): boolean {
  try { localStorage.getItem(SYNC_BANNER_KEY); return false; } catch { return true; }
}
