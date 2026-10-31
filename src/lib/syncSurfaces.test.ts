import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const {
  badgeTooltip, deviceCountLabel, isCacheFresh, loadingModel, markIndicatorTipShown, popoverModel, readIndicatorTip,
  shouldShowIndicatorTip, surfaceIndicator, syncCommandAvailability, syncSettingsRow, INDICATOR_TIP_KEY, SYNC_PITCH,
  isDriveFull, titlebarIndicator, deviceDisplayName, requestSyncSetup,
} = await import("./syncSurfaces");
const { SYNC_START_SETUP_EVENT } = await import("./syncSetup");
type SyncStatus = import("./vaultSync").SyncStatus;

const NOW = 1_800_000_000_000;
const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: NOW - 5 * 60_000, lastError: null, pending: false, deviceId: "d1", deviceName: "Desk", ...o,
});
const off = (o: Partial<SyncStatus> = {}) => status({ enabled: false, state: "off", ...o });
const disconnected = (o: Partial<SyncStatus> = {}) => off({ provider: null, account: null, ...o });

describe("surfaceIndicator", () => {
  it("hides without a vault, before the status is known, and in builds that can't sync", () => {
    expect(surfaceIndicator(status(), false, NOW)).toBeNull();
    expect(surfaceIndicator(null, true, NOW)).toBeNull();
    expect(surfaceIndicator(disconnected({ configured: false }), true, NOW)).toBeNull();
  });

  it("shows a subtle Sync off while sync is off", () => {
    const a = surfaceIndicator(disconnected(), true, NOW)!;
    expect(a).toMatchObject({ kind: "off", label: "Sync off" });
    expect(a.tooltip).toContain("other PCs");
    expect(surfaceIndicator(off(), true, NOW)!.tooltip).toContain("turn it on");
  });

  it("follows the live state while sync is on", () => {
    expect(surfaceIndicator(status(), true, NOW)).toMatchObject({ kind: "synced", label: "Synced" });
    expect(surfaceIndicator(status({ state: "authNeeded" }), true, NOW)!.kind).toBe("problem");
    expect(surfaceIndicator(status({ state: "locked" }), true, NOW)!.kind).toBe("locked");
  });
});

describe("badgeTooltip", () => {
  it.each([
    [status(), "Synced with Google Drive · me@gmail.com"],
    [status({ pending: true }), "Changes waiting to sync with Google Drive · me@gmail.com"],
    [status({ state: "syncing" }), "Syncing with Google Drive… · me@gmail.com"],
    [status({ state: "error", lastError: "Drive is full" }), "Sync problem: Drive is full"],
    [status({ state: "authNeeded" }), "Sync problem: Google needs you to sign in again"],
    [status({ state: "locked" }), "Sync paused while the vault is locked"],
    [off(), "Sync off · me@gmail.com"],
    [disconnected(), "Sync off"],
  ] as [SyncStatus, string][])("%#: %s", (s, text) => {
    expect(badgeTooltip(s, true)).toBe(text);
  });

  it("is hidden when the indicator is", () => {
    expect(badgeTooltip(status(), false)).toBeNull();
    expect(badgeTooltip(null, true)).toBeNull();
    expect(badgeTooltip(disconnected({ configured: false }), true)).toBeNull();
  });
});

describe("popoverModel", () => {
  it("off with a reason from Notiq: shows it, Turn On Sync", () => {
    const m = popoverModel(off({ lastError: "Sync was turned off because this device now has a different vault." }), NOW);
    expect(m).toMatchObject({ messageTone: "danger", actions: ["turnOn", "settings"] });
    expect(m.message).toContain("different vault");
  });

  it("not connected: the pitch and Connect", () => {
    const m = popoverModel(disconnected(), NOW);
    expect(m).toMatchObject({ connected: false, account: null, location: null, message: SYNC_PITCH, actions: ["connect"], showDevices: false });
    expect(m.badge.label).toBe("Off");
  });

  it("not configured: explains, no actions", () => {
    const m = popoverModel(disconnected({ configured: false }), NOW);
    expect(m.actions).toEqual([]);
    expect(m.message).toContain("isn't available");
  });

  it("connected but off: Turn on sync first, account shown", () => {
    const m = popoverModel(off(), NOW);
    expect(m.actions).toEqual(["turnOn", "settings"]);
    expect(m).toMatchObject({ account: "me@gmail.com", avatar: "M", location: "Google Drive · This PC: Desk", lastSynced: null });
  });

  it("synced: last synced, devices, Sync now first", () => {
    const m = popoverModel(status(), NOW);
    expect(m).toMatchObject({ badge: { label: "Synced", tone: "ok" }, lastSynced: "Last synced 5 minutes ago", showDevices: true, actions: ["syncNow", "settings"], disabled: [] });
  });

  it("syncing: Sync now disabled", () => {
    expect(popoverModel(status({ state: "syncing" }), NOW)).toMatchObject({ badge: { tone: "busy" }, disabled: ["syncNow"] });
  });

  it("error: the reason replaces Last synced, ONE action: Retry", () => {
    const m = popoverModel(status({ state: "error", lastError: "Something broke" }), NOW);
    expect(m).toMatchObject({ message: "Something broke", messageTone: "danger", actions: ["retry", "settings"], badge: { tone: "danger" }, lastSynced: null, showDevices: false });
  });

  it("Drive full: says so and opens the storage page", () => {
    const m = popoverModel(status({ state: "error", lastError: "Your Google Drive storage is full." }), NOW);
    expect(m.message).toMatch(/^Google Drive is full/);
    expect(m.actions).toEqual(["openStorage", "settings"]);
    expect(isDriveFull("Your Google Drive storage is full.")).toBe(true);
    expect(isDriveFull("Network down")).toBe(false);
    expect(isDriveFull(null)).toBe(false);
  });

  it("authNeeded: Reconnect", () => {
    const m = popoverModel(status({ state: "authNeeded" }), NOW);
    expect(m.actions[0]).toBe("reconnect");
    expect(m.messageTone).toBe("danger");
  });

  it("locked: resumes after unlock, Unlock first", () => {
    const m = popoverModel(status({ state: "locked" }), NOW);
    expect(m.message).toMatch(/resumes after you unlock/);
    expect(m.actions).toEqual(["unlock", "settings"]);
  });

  it("offline: no action, will sync when back online; pending explains itself", () => {
    expect(popoverModel(status({ state: "offline" }), NOW)).toMatchObject({
      badge: { tone: "warn" }, actions: ["settings"], lastSynced: null, message: "Offline. Will sync when you're back online.",
    });
    expect(popoverModel(status({ pending: true }), NOW).message).toContain("waiting to upload");
  });

  it("this PC falls back when the device has no name", () => {
    expect(popoverModel(status({ deviceName: "" }), NOW).location).toBe("Google Drive · This PC: this PC");
  });

  it("loading and failed status", () => {
    expect(loadingModel(null)).toMatchObject({ message: "Checking sync…", actions: [] });
    expect(loadingModel("boom")).toMatchObject({ message: "Couldn't check sync: boom", actions: ["recheck"], messageTone: "danger" });
  });
});

describe("small helpers", () => {
  it("device count and cache", () => {
    expect(deviceCountLabel(1)).toBe("1 PC");
    expect(deviceCountLabel(3)).toBe("3 PCs");
    expect(isCacheFresh(null, NOW)).toBe(false);
    expect(isCacheFresh(NOW - 1000, NOW)).toBe(true);
    expect(isCacheFresh(NOW - 31_000, NOW)).toBe(false);
  });

  it("Sync settings lands on the status row once connected", () => {
    expect(syncSettingsRow(status())).toBe("vault.sync.status");
    expect(syncSettingsRow(disconnected())).toBe("vault.sync.account");
    expect(syncSettingsRow(null)).toBe("vault.sync.account");
  });
});

describe("syncCommandAvailability", () => {
  const unlocked = { exists: true, unlocked: true };
  it("without a vault: Connect for new users, Settings once connected, never Sync now", () => {
    const none = { exists: false, unlocked: false };
    expect(syncCommandAvailability(status(), none)).toEqual({ syncNow: false, settings: true, connect: false });
    expect(syncCommandAvailability(disconnected(), none)).toEqual({ syncNow: false, settings: false, connect: true });
    expect(syncCommandAvailability(disconnected({ configured: false }), none)).toEqual({ syncNow: false, settings: false, connect: false });
    expect(syncCommandAvailability(null, none)).toEqual({ syncNow: false, settings: false, connect: false });
  });
  it("connect only when configured and not connected", () => {
    expect(syncCommandAvailability(disconnected(), unlocked)).toEqual({ syncNow: false, settings: true, connect: true });
    expect(syncCommandAvailability(disconnected({ configured: false }), unlocked).connect).toBe(false);
    expect(syncCommandAvailability(status(), unlocked).connect).toBe(false);
    expect(syncCommandAvailability(null, unlocked)).toEqual({ syncNow: false, settings: true, connect: false });
  });
  it("sync now only when enabled and unlocked", () => {
    expect(syncCommandAvailability(status(), unlocked).syncNow).toBe(true);
    expect(syncCommandAvailability(status(), { exists: true, unlocked: false }).syncNow).toBe(false);
    expect(syncCommandAvailability(status({ state: "locked" }), unlocked).syncNow).toBe(false);
    expect(syncCommandAvailability(off(), unlocked).syncNow).toBe(false);
  });
});

describe("indicator tip flag", () => {
  const mem = new Map<string, string>();
  const fake = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  };
  afterEach(() => { mem.clear(); vi.unstubAllGlobals(); });

  it("shows only while pending and the indicator is visible", () => {
    expect(shouldShowIndicatorTip("pending", true)).toBe(true);
    expect(shouldShowIndicatorTip("pending", false)).toBe(false);
    expect(shouldShowIndicatorTip("shown", true)).toBe(false);
    expect(shouldShowIndicatorTip(null, true)).toBe(false);
  });

  it("reads and marks the shared key", () => {
    vi.stubGlobal("localStorage", fake);
    mem.set(INDICATOR_TIP_KEY, "pending");
    expect(readIndicatorTip()).toBe("pending");
    markIndicatorTipShown();
    expect(mem.get("notiq.sync.indicatorTip")).toBe("shown");
  });

  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); } });
    expect(readIndicatorTip()).toBeNull();
    expect(() => markIndicatorTipShown()).not.toThrow();
  });
});

describe("titlebarIndicator", () => {
  it("shows whenever this build can sync, with or without a vault", () => {
    expect(titlebarIndicator(null, NOW)).toBeNull();
    expect(titlebarIndicator(disconnected({ configured: false }), NOW)).toBeNull();
    expect(titlebarIndicator(disconnected(), NOW)).toMatchObject({ kind: "off", label: "Sync off" });
    expect(titlebarIndicator(disconnected(), NOW)!.tooltip).toContain("other PCs");
    expect(titlebarIndicator(off(), NOW)!.tooltip).toContain("turn it on");
    // Connected in a build without a client id still shows (settings matter).
    expect(titlebarIndicator(status({ configured: false }), NOW)!.kind).toBe("synced");
  });

  it.each([
    [status(), "synced"],
    [status({ state: "syncing" }), "syncing"],
    [status({ state: "offline" }), "offline"],
    [status({ state: "error", lastError: "x" }), "problem"],
    [status({ state: "authNeeded" }), "problem"],
    [status({ state: "locked" }), "locked"],
  ] as [SyncStatus, string][])("%#: same states as the status bar (%s)", (s, kind) => {
    expect(titlebarIndicator(s, NOW)!.kind).toBe(kind);
    expect(titlebarIndicator(s, NOW)).toEqual(surfaceIndicator(s, true, NOW));
  });
});

describe("device names and the set-up hand-off", () => {
  it("never shows an id: Unnamed device when the name is unknown", () => {
    expect(deviceDisplayName({ name: "CODEMUNI" })).toBe("CODEMUNI");
    expect(deviceDisplayName({ name: "" })).toBe("Unnamed device");
    expect(deviceDisplayName({ name: "   " })).toBe("Unnamed device");
  });

  it("requestSyncSetup dispatches notiq:sync-start-setup (no detail) and is safe without listeners", () => {
    expect(SYNC_START_SETUP_EVENT).toBe("notiq:sync-start-setup");
    const target = new EventTarget();
    const seen: Event[] = [];
    target.addEventListener(SYNC_START_SETUP_EVENT, (e) => seen.push(e));
    vi.stubGlobal("window", target);
    requestSyncSetup();
    expect(seen).toHaveLength(1);
    expect((seen[0] as CustomEvent).detail).toBeNull();
    vi.stubGlobal("window", undefined);
    expect(() => requestSyncSetup()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
