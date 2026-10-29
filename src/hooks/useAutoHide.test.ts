import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { armAutoHide, VAULT_HIDE_SECRETS_EVENT } from "./useAutoHide";
import { parseAutoHideSeconds, shouldLockOnSession } from "../lib/vaultPrefs";

describe("prefs parsing", () => {
  it("defaults and validates", () => {
    expect(parseAutoHideSeconds(null)).toBe(30);
    expect(parseAutoHideSeconds("15")).toBe(15);
    expect(parseAutoHideSeconds("0")).toBe(0);
    expect(parseAutoHideSeconds("7")).toBe(30);
    expect(parseAutoHideSeconds("abc")).toBe(30);
  });
  it("shouldLockOnSession needs pref and unlocked", () => {
    expect(shouldLockOnSession(true, true)).toBe(true);
    expect(shouldLockOnSession(false, true)).toBe(false);
    expect(shouldLockOnSession(true, false)).toBe(false);
  });
});

class Doc extends EventTarget { visibilityState = "visible"; }

describe("armAutoHide", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hides after the delay", () => {
    const hide = vi.fn();
    armAutoHide(hide, 30, new EventTarget(), new Doc());
    vi.advanceTimersByTime(29_000);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(hide).toHaveBeenCalledTimes(1);
  });
  it("0 seconds means no timer", () => {
    const hide = vi.fn();
    armAutoHide(hide, 0, new EventTarget(), new Doc());
    vi.advanceTimersByTime(600_000);
    expect(hide).not.toHaveBeenCalled();
  });
  it("hides on blur, hidden page and the hide-secrets event", () => {
    const hide = vi.fn();
    const win = new EventTarget();
    const doc = new Doc();
    armAutoHide(hide, 0, win, doc);
    win.dispatchEvent(new Event("blur"));
    win.dispatchEvent(new Event(VAULT_HIDE_SECRETS_EVENT));
    doc.visibilityState = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(hide).toHaveBeenCalledTimes(2);
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(hide).toHaveBeenCalledTimes(3);
  });
  it("disposer cancels everything", () => {
    const hide = vi.fn();
    const win = new EventTarget();
    const off = armAutoHide(hide, 5, win, new Doc());
    off();
    vi.advanceTimersByTime(10_000);
    win.dispatchEvent(new Event("blur"));
    expect(hide).not.toHaveBeenCalled();
  });
});
