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
