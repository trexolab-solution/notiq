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

import { OFF_MINUTES, PAUSED_VALUE, offValue, parseCaptureShieldStatus, pausedLabel } from "./captureShield";

describe("captureShield off for N minutes", () => {
  it("offers 5, 10, 15 and 20 minutes", () => {
    expect([...OFF_MINUTES]).toEqual([5, 10, 15, 20]);
    expect(offValue(15)).toBe("off:15");
    expect(PAUSED_VALUE).toBe("paused");
  });
  it("reads the backend status tolerantly", () => {
    expect(parseCaptureShieldStatus({ mode: "always", offUntilMs: 5000 })).toEqual({ mode: "always", offUntil: 5000 });
    expect(parseCaptureShieldStatus({ mode: "off" })).toEqual({ mode: "off", offUntil: null });
    expect(parseCaptureShieldStatus(null)).toEqual({ mode: DEFAULT_CAPTURE_SHIELD, offUntil: null });
  });
  it("shows the minutes left, rounded up, at least 1", () => {
    expect(pausedLabel(10 * 60_000, 0)).toBe("Off · 10 min left");
    expect(pausedLabel(61_000, 0)).toBe("Off · 2 min left");
    expect(pausedLabel(1_000, 0)).toBe("Off · 1 min left");
  });
});
