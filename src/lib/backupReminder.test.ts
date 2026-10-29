import { describe, expect, it } from "vitest";
import { backupReminderReason, isBackupDue, snoozeUntil, describeAge, type ReminderInput } from "./backupReminder";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const base: ReminderInput = { now: NOW, lastBackup: null, vaultSince: null, snoozedUntil: null, disabled: false };

describe("backup reminder", () => {
  it("is not due for a brand-new vault", () => {
    expect(isBackupDue({ ...base, vaultSince: NOW - 2 * DAY })).toBe(false);
  });
  it("is due when never backed up and the vault is >= 3 days old", () => {
    expect(backupReminderReason({ ...base, vaultSince: NOW - 3 * DAY })).toBe("never");
  });
  it("is not due when the vault age is unknown", () => {
    expect(isBackupDue(base)).toBe(false);
  });
  it("is due when the last backup is over 30 days old", () => {
    expect(backupReminderReason({ ...base, lastBackup: NOW - 31 * DAY })).toBe("stale");
    expect(isBackupDue({ ...base, lastBackup: NOW - 30 * DAY })).toBe(false);
    expect(isBackupDue({ ...base, lastBackup: NOW - 2 * DAY, vaultSince: NOW - 90 * DAY })).toBe(false);
  });
  it("snoozes for 7 days", () => {
    const due = { ...base, lastBackup: NOW - 40 * DAY };
    expect(snoozeUntil(NOW)).toBe(NOW + 7 * DAY);
    expect(isBackupDue({ ...due, snoozedUntil: NOW + DAY })).toBe(false);
    expect(isBackupDue({ ...due, snoozedUntil: NOW - 1 })).toBe(true);
  });
  it("never shows when disabled", () => {
    expect(isBackupDue({ ...base, lastBackup: NOW - 99 * DAY, disabled: true })).toBe(false);
  });
  it("describes age", () => {
    expect(describeAge(NOW - 1000, NOW)).toBe("today");
    expect(describeAge(NOW - DAY, NOW)).toBe("yesterday");
    expect(describeAge(NOW - 12 * DAY, NOW)).toBe("12 days ago");
  });
});
