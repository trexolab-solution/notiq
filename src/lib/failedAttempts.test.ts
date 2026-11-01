import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const warning = vi.fn();
vi.mock("./toast", () => ({ toast: { warning: (...a: unknown[]) => warning(...a) } }));

import { attemptTimeLabel, failedAttemptsMessage, showFailedAttemptsNotice } from "./failedAttempts";

const NOW = new Date(2026, 10, 1, 18, 30); // 1 Nov 2026, 18:30 local

describe("failed unlock attempts notice", () => {
  beforeEach(() => { invoke.mockReset(); warning.mockReset(); });

  it("words the count and the time of the last attempt", () => {
    const last = new Date(2026, 10, 1, 14, 2).getTime();
    expect(failedAttemptsMessage({ count: 3, last_ms: last }, NOW))
      .toBe("3 failed unlock attempts since your last unlock · last one today 14:02");
    expect(failedAttemptsMessage({ count: 1, last_ms: last }, NOW)).toMatch(/^1 failed unlock attempt since/);
  });

  it("labels today, yesterday and older days", () => {
    expect(attemptTimeLabel(new Date(2026, 10, 1, 0, 5), NOW)).toBe("today 00:05");
    expect(attemptTimeLabel(new Date(2026, 9, 31, 23, 59), NOW)).toBe("yesterday 23:59");
    const older = attemptTimeLabel(new Date(2026, 9, 28, 9, 7), NOW);
    expect(older.startsWith("on ")).toBe(true);
    expect(older.endsWith(" 09:07")).toBe(true);
    expect(older).not.toMatch(/2026/);
    expect(attemptTimeLabel(new Date(2025, 9, 28, 9, 7), NOW)).toMatch(/2025/);
  });

  it("shows one warning when the backend hands over attempts, nothing otherwise", async () => {
    invoke.mockResolvedValueOnce(null);
    await showFailedAttemptsNotice();
    expect(warning).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({ count: 2, last_ms: Date.now() });
    await showFailedAttemptsNotice();
    expect(invoke).toHaveBeenCalledWith("vault_take_failed_attempts");
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0][0]).toMatch(/^2 failed unlock attempts since your last unlock · last one today/);

    invoke.mockRejectedValueOnce("boom");
    await expect(showFailedAttemptsNotice()).resolves.toBeUndefined();
  });
});
