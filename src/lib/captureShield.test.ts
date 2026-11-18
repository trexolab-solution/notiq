import { describe, expect, it } from "vitest";
import { CAPTURE_SHIELD_OPTIONS, DEFAULT_CAPTURE_SHIELD, parseCaptureShield } from "./captureShield";

describe("captureShield", () => {
  it("accepts the three modes and falls back to the default", () => {
    expect(parseCaptureShield("always")).toBe("always");
    expect(parseCaptureShield("off")).toBe("off");
    expect(parseCaptureShield("while_unlocked")).toBe("while_unlocked");
    expect(parseCaptureShield("nope")).toBe(DEFAULT_CAPTURE_SHIELD);
    expect(parseCaptureShield(null)).toBe(DEFAULT_CAPTURE_SHIELD);
  });
  it("offers every mode once, default first", () => {
    expect(CAPTURE_SHIELD_OPTIONS.map((o) => o.value)).toEqual(["while_unlocked", "always", "off"]);
  });
});

import { HIDING_VALUE, HIDE_MINUTES, parseCaptureShieldStatus, hideValue, hidingLabel } from "./captureShield";

describe("captureShield hide for N minutes", () => {
  it("offers 5, 10 and 30 minutes", () => {
    expect([...HIDE_MINUTES]).toEqual([5, 10, 30]);
    expect(hideValue(10)).toBe("hide:10");
    expect(HIDING_VALUE).toBe("hiding");
  });
  it("reads the backend status tolerantly", () => {
    expect(parseCaptureShieldStatus({ mode: "always", hiddenUntilMs: 5000 })).toEqual({ mode: "always", hiddenUntil: 5000 });
    expect(parseCaptureShieldStatus({ mode: "off" })).toEqual({ mode: "off", hiddenUntil: null });
    expect(parseCaptureShieldStatus(null)).toEqual({ mode: DEFAULT_CAPTURE_SHIELD, hiddenUntil: null });
  });
  it("shows the minutes left, rounded up, at least 1", () => {
    expect(hidingLabel(10 * 60_000, 0)).toBe("Hidden · 10 min left");
    expect(hidingLabel(61_000, 0)).toBe("Hidden · 2 min left");
    expect(hidingLabel(1_000, 0)).toBe("Hidden · 1 min left");
  });
});
