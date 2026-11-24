import { describe, expect, it } from "vitest";
import {
  clampTime, compose, dayAllowed, daysInMonth, decompose, defaultAt, formatPicked, from12, monthCells, monthLabel, shiftMonth, to12,
  weekdayLabels,
} from "./dateTime";

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

describe("12-hour clock", () => {
  it("goes both ways around midnight and noon", () => {
    expect([0, 1, 11, 12, 13, 16, 23].map((h) => to12(h))).toEqual([
      { hour12: 12, pm: false }, { hour12: 1, pm: false }, { hour12: 11, pm: false }, { hour12: 12, pm: true },
      { hour12: 1, pm: true }, { hour12: 4, pm: true }, { hour12: 11, pm: true },
    ]);
    expect([[12, false], [1, false], [11, false], [12, true], [1, true], [4, true], [11, true]].map(([h, pm]) => from12(h as number, pm as boolean)))
      .toEqual([0, 1, 11, 12, 13, 16, 23]);
    for (let h = 0; h < 24; h++) expect(from12(to12(h).hour12, to12(h).pm)).toBe(h);
  });
});

describe("date parts", () => {
  it("take a moment apart and put it together again", () => {
    const t = at(2026, 11, 1, 16, 5);
    expect(decompose(t)).toEqual({ year: 2026, month: 11, day: 1, hour12: 4, minute: 5, pm: true });
    expect(compose(decompose(t))).toBe(t);
    expect(compose({ year: 2026, month: 11, day: 1, hour12: 12, minute: 0, pm: false })).toBe(at(2026, 11, 1, 0, 0));
    expect(compose({ year: 2026, month: 11, day: 1, hour12: 12, minute: 30, pm: true })).toBe(at(2026, 11, 1, 12, 30));
  });
  it("clamps a day past the end of the month", () => {
    expect(compose({ year: 2026, month: 1, day: 31, hour12: 4, minute: 0, pm: true })).toBe(at(2026, 1, 28, 16, 0));
    expect(compose({ year: 2028, month: 1, day: 31, hour12: 4, minute: 0, pm: true })).toBe(at(2028, 1, 29, 16, 0));
  });
  it("counts the days of a month, leap years included", () => {
    expect([daysInMonth(2026, 0), daysInMonth(2026, 1), daysInMonth(2028, 1), daysInMonth(2026, 3)]).toEqual([31, 28, 29, 30]);
  });
  it("moves a month at a time across a year", () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 5, 1)).toEqual({ year: 2026, month: 6 });
  });
});

describe("the month grid", () => {
  it("is six rows of seven with blanks before the 1st and after the last day", () => {
    // December 2026 starts on a Tuesday (the third column when the week starts on Sunday).
    const cells = monthCells(2026, 11, 0);
    expect(cells).toHaveLength(42);
    expect(cells.slice(0, 2)).toEqual([null, null]);
    expect(cells[2]).toBe(1);
    expect(cells.filter((c) => c != null)).toHaveLength(31);
    expect(cells.filter((c) => c != null).at(-1)).toBe(31);
    expect(cells[2 + 30]).toBe(31);
    expect(cells.slice(33).every((c) => c == null)).toBe(true);
  });
  it("can start the week on Monday", () => {
    const cells = monthCells(2026, 11, 1);
    expect(cells[0]).toBeNull();
    expect(cells[1]).toBe(1);
    // A month starting on the first column has no blanks before it.
    expect(monthCells(2026, 1, 0)[0]).toBe(1); // 1 Feb 2026 is a Sunday
  });
  it("names the weekdays and the month in the user's language", () => {
    expect(weekdayLabels("en-US", 0)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(weekdayLabels("en-US", 1)[0]).toBe("Mon");
    expect(monthLabel(2026, 11, "en-US")).toBe("December 2026");
  });
});

describe("which days can be chosen", () => {
  const now = at(2026, 10, 24, 15, 0);
  const max = now + 365 * 86_400_000;
  it("today still can (some of it is ahead); yesterday can't", () => {
    expect(dayAllowed(2026, 10, 24, now, max)).toBe(true);
    expect(dayAllowed(2026, 10, 23, now, max)).toBe(false);
    expect(dayAllowed(2026, 10, 25, now, max)).toBe(true);
  });
  it("the last day within the year can; the day after can't", () => {
    const last = new Date(max);
    expect(dayAllowed(last.getFullYear(), last.getMonth(), last.getDate(), now, max)).toBe(true);
    const after = new Date(max + 86_400_000);
    expect(dayAllowed(after.getFullYear(), after.getMonth(), after.getDate(), now, max)).toBe(false);
  });
});

describe("a time worth suggesting", () => {
  it("is the next full hour, and the one after when that is under half an hour away", () => {
    expect(defaultAt(at(2026, 10, 24, 12, 0))).toBe(at(2026, 10, 24, 13, 0));
    expect(defaultAt(at(2026, 10, 24, 12, 20))).toBe(at(2026, 10, 24, 13, 0));
    expect(defaultAt(at(2026, 10, 24, 12, 31))).toBe(at(2026, 10, 24, 14, 0));
    expect(defaultAt(at(2026, 10, 24, 23, 45))).toBe(at(2026, 10, 25, 1, 0));
  });
  it("clamps inside a range", () => {
    expect(clampTime(5, 10, 20)).toBe(10);
    expect(clampTime(25, 10, 20)).toBe(20);
    expect(clampTime(15, 10, 20)).toBe(15);
  });
  it("reads as a short sentence", () => {
    expect(formatPicked(at(2026, 11, 1, 16, 0), "en-US")).toBe("Tue, Dec 1, 2026 · 4:00 PM");
  });
});
