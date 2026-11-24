/** Pure date and time helpers for the date and time picker. Everything is in the user's own time zone. */

export interface Parts {
  year: number;
  /** 0 to 11. */
  month: number;
  day: number;
  /** 1 to 12. */
  hour12: number;
  /** 0 to 59. */
  minute: number;
  pm: boolean;
}

/** 24-hour clock to 12-hour: 0 is 12 AM, 12 is 12 PM, 16 is 4 PM. */
export function to12(hour24: number): { hour12: number; pm: boolean } {
  return { hour12: hour24 % 12 === 0 ? 12 : hour24 % 12, pm: hour24 >= 12 };
}

/** 12-hour clock to 24-hour: 12 AM is 0, 12 PM is 12, 4 PM is 16. */
export function from12(hour12: number, pm: boolean): number {
  return (hour12 % 12) + (pm ? 12 : 0);
}

/** The local date and time of a moment, in picker parts. */
export function decompose(ms: number): Parts {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), minute: d.getMinutes(), ...to12(d.getHours()) };
}

/** The moment of a local date and time. A day past the end of the month is clamped to its last day. */
export function compose(p: Parts): number {
  const day = Math.min(p.day, daysInMonth(p.year, p.month));
  return new Date(p.year, p.month, day, from12(p.hour12, p.pm), p.minute, 0, 0).getTime();
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/** The month before or after (`delta` = ±1), carrying the year. */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/**
 * The cells of a month, six rows of seven: the day of the month, or `null` for a blank before the 1st and after the
 * last day. `weekStart` is the first column (0 = Sunday, 1 = Monday).
 */
export function monthCells(year: number, month: number, weekStart = 0): (number | null)[] {
  const lead = (new Date(year, month, 1).getDay() - weekStart + 7) % 7;
  const total = daysInMonth(year, month);
  return Array.from({ length: 42 }, (_, i) => (i >= lead && i < lead + total ? i - lead + 1 : null));
}

/** Short weekday names for the header row, from `weekStart`, in the user's language. */
export function weekdayLabels(locale?: string, weekStart = 0): string[] {
  const f = new Intl.DateTimeFormat(locale, { weekday: "short" });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2023, 0, 1 + ((i + weekStart) % 7))));
}

/** "December 2026". */
export function monthLabel(year: number, month: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(new Date(year, month, 1));
}

/** Whether any moment of that day is inside `min`..`max` (both Unix ms): the day can be chosen. */
export function dayAllowed(year: number, month: number, day: number, min: number, max: number): boolean {
  const start = new Date(year, month, day, 0, 0, 0, 0).getTime();
  const end = new Date(year, month, day + 1, 0, 0, 0, 0).getTime() - 1;
  return end >= min && start <= max;
}

/** The first moment worth suggesting: the next full hour, at least half an hour from `now`. */
export function defaultAt(now: number): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  let t = d.getTime() + 3_600_000;
  if (t - now < 30 * 60_000) t += 3_600_000;
  return t;
}

/** Moves `ms` inside `min`..`max`. */
export function clampTime(ms: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, ms));
}

/** "Tue, 1 Dec 2026 · 4:00 PM", in the user's language. */
export function formatPicked(ms: number, locale?: string): string {
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  return `${date} · ${time}`;
}

/** The time zone the user's clock is in ("Asia/Kolkata"), or "" when the system won't say. */
export function timeZoneName(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { return ""; }
}
