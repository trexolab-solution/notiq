import { describe, expect, it } from "vitest";
import { canAutoCheck, UPDATE_CHECK_INTERVAL_MS } from "./updateSchedule";

describe("update schedule", () => {
  it("checks hourly", () => {
    expect(UPDATE_CHECK_INTERVAL_MS).toBe(3_600_000);
  });

  it("checks when idle, up to date, or after an error (retry later)", () => {
    for (const s of ["idle", "uptodate", "error"]) expect(canAutoCheck(s)).toBe(true);
  });

  it("stays out of the way while busy or when an update is already waiting", () => {
    for (const s of ["checking", "downloading", "ready", "available"]) expect(canAutoCheck(s)).toBe(false);
  });
});
