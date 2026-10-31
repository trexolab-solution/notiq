/**
 * Vault Sync "surfaces" (0.9.0): what the title bar cloud button, the status-bar indicator, the sync popover,
 * the vault sidebar badge and the command palette show for a sync status. Pure functions of the status (plus the vault state), so every branch
 * is unit-testable without a DOM; the components only render what these return.
 *
 * The one-time indicator tip flag lives here too, as standalone localStorage (like `lib/firstRun.ts`) so a
 * preferences reset doesn't bring it back.
 */
import { relativeTime, syncIndicator, type SyncDevice, type SyncIndicatorKind, type SyncStatus } from "./vaultSync";
import { SYNC_START_SETUP_EVENT } from "./syncSetup";

/** Window event that opens the sync popover (CustomEvent; `detail` is optional, see `SyncPopoverRequest`). */
export const OPEN_SYNC_POPOVER_EVENT = "notiq:open-sync-popover";

/** Optional `detail` of `OPEN_SYNC_POPOVER_EVENT`. Dispatching without a detail is fine. */
export interface SyncPopoverRequest {
  /** Element to anchor to; defaults to the status-bar indicator. */
  anchor?: HTMLElement | null;
  /** Start this action as soon as the popover opens. */
  action?: "connect";
}

/**
 * Asks for the sync set-up decision flow (sign in, then create / open / upload / two vaults) by dispatching
 * `notiq:sync-start-setup` (CustomEvent, no detail; `SYNC_START_SETUP_EVENT` from ./syncSetup), which
 * `SyncSetupHost` handles. Used by the popover's off states and the palette, so the surfaces don't import the
 * flow itself. Safe without a window or listener (nothing happens).
 */
export function requestSyncSetup(): void {
  try { window.dispatchEvent(new CustomEvent(SYNC_START_SETUP_EVENT)); }
  catch { /* no window (tests / SSR): nothing to start */ }
}

/** Settings row the "Sync settings" action opens. */
export const SYNC_SETTINGS_ROW = "vault.sync.status";

/** "Sync status" only renders once connected; before that, land on the account row (Connect). */
export const syncSettingsRow = (s: SyncStatus | null) => (s?.provider ? SYNC_SETTINGS_ROW : "vault.sync.account");

// ── Indicator (status bar) ──────────────────────────────────────────────────────

export type SurfaceKind = SyncIndicatorKind | "off";
export interface SurfaceIndicator { kind: SurfaceKind; label: string; tooltip: string }

/** Whether this build can sync at all, or is already connected (then sync settings still matter). */
export const syncPossible = (s: SyncStatus) => s.configured || !!s.provider;

/**
 * The status-bar indicator: hidden without a vault or before the status is known (or in a build that can't
 * sync); a subtle "Sync off" while sync is off; else the live state from `syncIndicator`.
 */
export function surfaceIndicator(s: SyncStatus | null, vaultExists: boolean, now = Date.now()): SurfaceIndicator | null {
  if (!vaultExists || !s || !syncPossible(s)) return null;
  const live = syncIndicator(s, now);
  if (live) return live;
  return {
    kind: "off",
    label: "Sync off",
    tooltip: s.provider
      ? "Vault sync is off on this PC. Click to turn it on."
      : "Vault sync is off. Click to keep this vault on your other PCs.",
  };
}

/**
 * The title bar cloud button: shown whenever this build can sync (or an account is connected) - also with
 * NO local vault, so new users find sync. Same states as the status bar; "off" while not connected / off.
 */
export function titlebarIndicator(s: SyncStatus | null, now = Date.now()): SurfaceIndicator | null {
  if (!s || !syncPossible(s)) return null;
  const live = syncIndicator(s, now);
  if (live) return live;
  return {
    kind: "off",
    label: "Sync off",
    tooltip: s.provider
      ? "Vault sync: off on this PC. Click to turn it on."
      : "Vault sync: off. Click to use your vault on all your PCs.",
  };
}

/** Tooltip of the vault sidebar cloud badge (null hides the badge, same rule as the indicator). */
export function badgeTooltip(s: SyncStatus | null, vaultExists: boolean): string | null {
  if (!vaultExists || !s || !syncPossible(s)) return null;
  const who = s.account ? ` · ${s.account}` : "";
  if (!s.provider) return "Sync off";
  if (!s.enabled || s.state === "off") return `Sync off${who}`;
  switch (s.state) {
    case "syncing": return `Syncing with Google Drive…${who}`;
    case "offline": return `Offline · changes sync when you're back online${who}`;
    case "error": return `Sync problem: ${s.lastError ?? "the last sync failed"}`;
    case "authNeeded": return "Sync problem: Google needs you to sign in again";
    case "locked": return "Sync paused while the vault is locked";
    default:
      return s.pending
        ? `Changes waiting to sync with Google Drive${who}`
        : `Synced with Google Drive${who}`;
  }
}

// ── Popover view model ──────────────────────────────────────────────────────────

/**
 * `connect` / `turnOn` start the set-up decision flow (`requestSyncSetup`); `settings` renders as a link;
 * `openStorage` opens Google's storage page (Drive full).
 */
export type PopoverAction = "syncNow" | "retry" | "reconnect" | "connect" | "turnOn" | "unlock" | "settings" | "recheck" | "openStorage";
export type BadgeTone = "ok" | "busy" | "warn" | "danger" | "muted";

export interface PopoverModel {
  badge: { label: string; tone: BadgeTone };
  connected: boolean;
  account: string | null;
  /** First letter of the account, for the avatar. */
  avatar: string | null;
  /** "Google Drive · This PC: Desk". */
  location: string | null;
  /** "Last synced 5 minutes ago" (only while sync is on). */
  lastSynced: string | null;
  /** Pitch, problem or pause explanation. */
  message: string | null;
  messageTone: "muted" | "danger";
  /** Whether to load and show the device count. */
  showDevices: boolean;
  /** Buttons in order; the first one is the primary. */
  actions: PopoverAction[];
  /** Actions shown but disabled right now. */
  disabled: PopoverAction[];
}

/** Button labels: sentence case like the rest of the app, no trailing periods. */
export const ACTION_LABELS: Record<PopoverAction, string> = {
  syncNow: "Sync now",
  retry: "Retry",
  reconnect: "Reconnect",
  connect: "Connect Google Drive",
  turnOn: "Turn on sync",
  unlock: "Unlock",
  settings: "Sync settings",
  recheck: "Retry",
  openStorage: "Open Drive storage",
};

export const SYNC_PITCH = "Use your vault on all your PCs. It's encrypted before it leaves this computer.";

/** Google's storage page (Drive full). */
export const DRIVE_STORAGE_URL = "https://one.google.com/storage";

/** The sync error says Google Drive is out of space (Rust: "Your Google Drive storage is full."). */
export const isDriveFull = (error: string | null | undefined): boolean =>
  !!error && /storage is full|drive is full|storageQuotaExceeded/i.test(error);

/** What the popover shows for a known status (see `loadingModel` before that). */
export function popoverModel(s: SyncStatus, now = Date.now()): PopoverModel {
  const connected = !!s.provider;
  const account = connected ? s.account : null;
  const base: PopoverModel = {
    badge: { label: "Off", tone: "muted" },
    connected,
    account,
    avatar: account ? account.trim().charAt(0).toUpperCase() || null : null,
    location: connected ? `Google Drive · This PC: ${s.deviceName || "this PC"}` : null,
    lastSynced: null,
    message: null,
    messageTone: "muted",
    showDevices: false,
    actions: [],
    disabled: [],
  };

  if (!connected) {
    if (!s.configured) return { ...base, message: "Sync isn't available in this build of Notiq." };
    return { ...base, message: SYNC_PITCH, actions: ["connect"] };
  }
  if (!s.enabled || s.state === "off") {
    // Paused here, or turned off by Notiq with a reason (e.g. a different local vault): say why.
    return s.lastError
      ? { ...base, message: s.lastError, messageTone: "danger", actions: ["turnOn", "settings"] }
      : { ...base, message: "Sync is off on this PC. Turn it on to use this vault on your other PCs.", actions: ["turnOn", "settings"] };
  }

  const on: PopoverModel = {
    ...base,
    lastSynced: `Last synced ${relativeTime(s.lastSyncedMs, now)}`,
    showDevices: true,
    actions: ["syncNow", "settings"],
  };
  // Problem states replace the "Last synced" line with the reason and ONE action (plus the settings link).
  const problem = (label: string, tone: BadgeTone, message: string, action: PopoverAction | null): PopoverModel => ({
    ...on, lastSynced: null, showDevices: false, badge: { label, tone }, message,
    messageTone: tone === "danger" ? "danger" : "muted",
    actions: action ? [action, "settings"] : ["settings"],
  });
  switch (s.state) {
    case "syncing":
      return { ...on, badge: { label: "Syncing", tone: "busy" }, disabled: ["syncNow"] };
    case "offline":
      return problem("Offline", "warn", "Offline. Will sync when you're back online.", null);
    case "error":
      return isDriveFull(s.lastError)
        ? problem("Drive full", "danger", "Google Drive is full. Free up space or get more storage, then sync again.", "openStorage")
        : problem("Problem", "danger", s.lastError ?? "The last sync failed.", "retry");
    case "authNeeded":
      return problem("Sign-in needed", "danger", "Google sign-in expired or access was removed. Reconnect to keep syncing.", "reconnect");
    case "locked":
      return {
        ...on, badge: { label: "Paused", tone: "muted" }, showDevices: false,
        message: "Sync paused while the vault is locked. It resumes after you unlock.", actions: ["unlock", "settings"],
      };
    default:
      return s.pending
        ? { ...on, badge: { label: "Waiting", tone: "busy" }, message: "Some changes are waiting to upload." }
        : { ...on, badge: { label: "Synced", tone: "ok" } };
  }
}

/** Before the status is known: "Checking sync…", or why reading it failed with a Retry (re-reads the status). */
export function loadingModel(error: string | null): PopoverModel {
  return {
    badge: { label: error ? "Unknown" : "Checking", tone: error ? "danger" : "muted" },
    connected: false, account: null, avatar: null, location: null, lastSynced: null,
    message: error ? `Couldn't check sync: ${error}` : "Checking sync…",
    messageTone: error ? "danger" : "muted",
    showDevices: false,
    actions: error ? ["recheck"] : [],
    disabled: [],
  };
}

/** "1 PC" / "3 PCs". */
export const deviceCountLabel = (n: number) => (n === 1 ? "1 PC" : `${n} PCs`);

/** A device's display name: never its id; "Unnamed device" when the name isn't known. */
export const deviceDisplayName = (d: Pick<SyncDevice, "name">) => d.name.trim() || "Unnamed device";

/** How long a fetched device count is reused before asking `sync_devices` again. */
export const DEVICE_CACHE_MS = 30_000;
export const isCacheFresh = (at: number | null, now: number, ttl = DEVICE_CACHE_MS) => at != null && now - at < ttl;

// ── Command palette ─────────────────────────────────────────────────────────────

export interface SyncCommandAvailability { syncNow: boolean; settings: boolean; connect: boolean }

/**
 * Which "Vault: …" sync commands the palette offers right now. "Connect Google Drive" (starts the set-up
 * flow) is offered without a local vault too, like the title bar button.
 */
export function syncCommandAvailability(
  s: SyncStatus | null, vault: { exists: boolean; unlocked: boolean },
): SyncCommandAvailability {
  const connect = !!s && s.configured && !s.provider;
  if (!vault.exists) return { syncNow: false, settings: !!s?.provider, connect };
  return {
    settings: true,
    connect,
    syncNow: !!s && !!s.provider && s.enabled && vault.unlocked && s.state !== "locked",
  };
}

// ── One-time indicator tip ──────────────────────────────────────────────────────

/** "pending" (set by the post-create "Not now") → the tip shows once → "shown". */
export const INDICATOR_TIP_KEY = "notiq.sync.indicatorTip";
/** Optional same-window nudge to re-read the tip flag right after setting it. */
export const INDICATOR_TIP_EVENT = "notiq:sync-indicator-tip";

export function readIndicatorTip(): string | null {
  try { return localStorage.getItem(INDICATOR_TIP_KEY); }
  catch { return null; } // storage unavailable → no tip
}

export function markIndicatorTipShown(): void {
  try { localStorage.setItem(INDICATOR_TIP_KEY, "shown"); }
  catch { /* ignore */ }
}

/** The tip shows only while the flag is "pending" and the indicator it points at is on screen. */
export const shouldShowIndicatorTip = (flag: string | null, indicatorVisible: boolean) =>
  flag === "pending" && indicatorVisible;

export const INDICATOR_TIP_TEXT = "Sync lives here. Click it whenever you want this vault on your other PCs.";

/** The title bar cloud button (tip + tour anchor; the popover's default anchor when present). */
export const SYNC_BUTTON_SELECTOR = '[data-tour="sync-button"]';
