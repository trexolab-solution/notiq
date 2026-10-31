import { beforeEach, describe, expect, it } from "vitest";
import {
  FIRST_UPLOAD_DONE, INDICATOR_TIP_KEY, OPEN_SYNC_POPOVER_EVENT, SYNC_BANNER_KEY, countEntries,
  createAuthNeededTracker, diffNewDevices, getIndicatorTip, isFirstUpload, isSyncBannerDone, loadSeenDevices,
  markSyncBannerDone, newDeviceMessage, openSyncPopover, saveSeenDevices, seenDevicesKey, setIndicatorTipPending,
  shouldOfferSyncOnboarding, shouldShowSyncBanner, uploadingMessage,
} from "./syncLifecycle";
import type { SyncDevice, SyncStatus } from "./vaultSync";

const mem = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
};
beforeEach(() => mem.clear());

const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: 1, lastError: null, pending: false, deviceId: "me", deviceName: "Desk", ...o,
});
const dev = (id: string, thisDevice = false): SyncDevice => ({ id, name: `PC ${id}`, lastSeenMs: null, thisDevice });

describe("first upload", () => {
  it("is a first upload only when Drive has no vault yet", () => {
    expect(isFirstUpload({ exists: false, sameVault: null })).toBe(true);
    expect(isFirstUpload({ exists: true, sameVault: true })).toBe(false);
    expect(isFirstUpload(null)).toBe(false);
  });

  it("counts notes, not folders", () => {
    expect(countEntries([{ dir: false }, { dir: true }, { dir: false }])).toBe(2);
    expect(countEntries(null)).toBeNull();
  });

  it("words the progress and done messages", () => {
    expect(uploadingMessage(12)).toBe("Uploading your vault… 12 items");
    expect(uploadingMessage(1)).toBe("Uploading your vault… 1 item");
    expect(uploadingMessage(null)).toBe("Uploading your vault…");
    expect(FIRST_UPLOAD_DONE).toBe("Your vault is now in Google Drive");
  });
});

describe("authNeeded notify-once", () => {
  it("notifies once per episode and clears when it ends", () => {
    const t = createAuthNeededTracker();
    expect(t(status())).toBeNull();
    expect(t(status({ state: "authNeeded" }))).toBe("notify");
    expect(t(status({ state: "authNeeded" }))).toBeNull();
    expect(t(status({ state: "authNeeded", pending: true }))).toBeNull();
    expect(t(status({ state: "idle" }))).toBe("clear");
    expect(t(status({ state: "idle" }))).toBeNull();
    expect(t(status({ state: "authNeeded" }))).toBe("notify");
    expect(t(null)).toBe("clear");
  });
});

describe("new devices", () => {
  it("seeds silently on the first load", () => {
    const r = diffNewDevices(null, [dev("me", true), dev("a"), dev("b")]);
    expect(r.added).toEqual([]);
    expect(r.seen.sort()).toEqual(["a", "b", "me"]);
  });

  it("announces only devices it hasn't seen, never this device", () => {
    const r = diffNewDevices(["me", "a"], [dev("me", true), dev("a"), dev("b"), dev("new-me", true)]);
    expect(r.added.map((d) => d.id)).toEqual(["b"]);
    expect(r.seen.sort()).toEqual(["a", "b", "me", "new-me"]);
  });

  it("announces a device at most once, even after it was removed and came back", () => {
    let seen: string[] | null = null;
    const step = (devices: SyncDevice[]) => { const r = diffNewDevices(seen, devices); seen = r.seen; return r.added.map((d) => d.id); };
    expect(step([dev("me", true)])).toEqual([]);
    expect(step([dev("me", true), dev("x")])).toEqual(["x"]);
    expect(step([dev("me", true)])).toEqual([]);
    expect(step([dev("me", true), dev("x")])).toEqual([]);
  });

  it("stores the seen set per synced vault (Google account)", () => {
    expect(seenDevicesKey("Me@Gmail.com ")).toBe(seenDevicesKey("me@gmail.com"));
    expect(seenDevicesKey(null)).toMatch(/default$/);
    const k = seenDevicesKey("me@gmail.com");
    expect(loadSeenDevices(k)).toBeNull();
    saveSeenDevices(k, ["a", "b"]);
    expect(loadSeenDevices(k)).toEqual(["a", "b"]);
    expect(loadSeenDevices(seenDevicesKey("other@gmail.com"))).toBeNull();
    mem.set(k, "not json");
    expect(loadSeenDevices(k)).toBeNull();
  });

  it("words the notice", () => {
    expect(newDeviceMessage("Laptop")).toBe("New device: Laptop joined your vault");
  });
});

describe("onboarding, banner and tip gates", () => {
  it("offers the post-create step only when Google sign-in exists and sync is off", () => {
    expect(shouldOfferSyncOnboarding(status({ provider: null, enabled: false, state: "off" }))).toBe(true);
    expect(shouldOfferSyncOnboarding(status({ configured: false, provider: null, enabled: false }))).toBe(false);
    expect(shouldOfferSyncOnboarding(status({ enabled: true }))).toBe(false);
    expect(shouldOfferSyncOnboarding(null)).toBe(false);
  });

  it("shows the banner for an existing vault with sync off, until done", () => {
    const off = status({ enabled: false, state: "off" });
    expect(shouldShowSyncBanner({ exists: true, status: off, done: false })).toBe(true);
    expect(shouldShowSyncBanner({ exists: false, status: off, done: false })).toBe(false);
    expect(shouldShowSyncBanner({ exists: true, status: status(), done: false })).toBe(false);
    expect(shouldShowSyncBanner({ exists: true, status: { ...off, configured: false }, done: false })).toBe(false);
    expect(shouldShowSyncBanner({ exists: true, status: null, done: false })).toBe(false);
    expect(shouldShowSyncBanner({ exists: true, status: off, done: true })).toBe(false);
  });

  it("remembers the banner once", () => {
    expect(isSyncBannerDone()).toBe(false);
    markSyncBannerDone();
    expect(isSyncBannerDone()).toBe(true);
    expect(mem.get(SYNC_BANNER_KEY)).toBe("done");
  });

  it("sets the indicator tip to pending unless it was already shown", () => {
    setIndicatorTipPending();
    expect(getIndicatorTip()).toBe("pending");
    mem.set(INDICATOR_TIP_KEY, "shown");
    setIndicatorTipPending();
    expect(getIndicatorTip()).toBe("shown");
  });

  it("dispatches the open-popover event", () => {
    const target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    let got = 0;
    target.addEventListener(OPEN_SYNC_POPOVER_EVENT, () => got++);
    openSyncPopover();
    expect(got).toBe(1);
  });
});
