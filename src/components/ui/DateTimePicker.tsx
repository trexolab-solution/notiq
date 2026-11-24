import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { CalendarClock, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useClickOutside } from "../../hooks/useClickOutside";
import { NumberField } from "./NumberField";
import {
  compose, dayAllowed, decompose, defaultAt, formatPicked, monthCells, monthLabel, shiftMonth, timeZoneName, weekdayLabels,
  type Parts,
} from "../../lib/dateTime";

const WIDTH = 296;

/**
 * A date and time field with a calendar of its own (no browser popup): a button that shows the chosen moment, and a
 * panel with a month to move through, the days, the time (hour, minutes, AM / PM) and the time zone it means. Days
 * outside `min`..`max` (Unix ms) can't be chosen. `bare` takes off the border, for use inside a bordered group.
 * `onChange` gets the moment as Unix ms; whether it is inside the range is the caller's to say (a time earlier today
 * is allowed to be typed and is then reported).
 */
export function DateTimePicker({ value, onChange, min, max, label, disabled, bare, invalid, placeholder = "Pick a date and time" }: {
  value: number | null;
  onChange: (ms: number) => void;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  bare?: boolean;
  invalid?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0, flipUp: false });

  // The part of the date being looked at, and the time being typed (the time may be half typed: an empty hour).
  const base: Parts = useMemo(() => decompose(value ?? defaultAt(Date.now())), [value]);
  const [view, setView] = useState({ year: base.year, month: base.month });
  const [time, setTime] = useState({ hour12: base.hour12, minute: base.minute, pm: base.pm });
  useEffect(() => {
    setTime({ hour12: base.hour12, minute: base.minute, pm: base.pm });
    if (open) return;
    setView({ year: base.year, month: base.month });
  }, [base, open]);

  const openPanel = useCallback(() => {
    if (disabled) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom;
    const flipUp = spaceBelow < 380 && rect.top > spaceBelow;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
    setPos({ top: flipUp ? rect.top - 6 : rect.bottom + 6, left, flipUp });
    setView({ year: base.year, month: base.month });
    setOpen(true);
  }, [disabled, base]);
  const close = useCallback(() => { setOpen(false); triggerRef.current?.focus(); }, []);
  useClickOutside([triggerRef, panelRef], () => setOpen(false), open);

  const onPanelKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };

  const cells = monthCells(view.year, view.month);
  const weekdays = useMemo(() => weekdayLabels(), []);
  const minView = decompose(min), maxView = decompose(max);
  const canPrev = view.year * 12 + view.month > minView.year * 12 + minView.month;
  const canNext = view.year * 12 + view.month < maxView.year * 12 + maxView.month;
  const today = decompose(Date.now());
  const picked = value != null ? decompose(value) : null;

  const emit = (p: Parts) => onChange(compose(p));
  // A half-typed hour or minutes (empty, or out of range) stays in the field and is not sent on; the last good one is used.
  const goodHour = (h: number) => (Number.isInteger(h) && h >= 1 && h <= 12 ? h : base.hour12);
  const goodMinute = (m: number) => (Number.isInteger(m) && m >= 0 && m <= 59 ? m : base.minute);
  const setHour = (h: number) => {
    setTime((t) => ({ ...t, hour12: h }));
    if (goodHour(h) === h) emit({ ...base, hour12: h, minute: goodMinute(time.minute), pm: time.pm });
  };
  const setMinute = (m: number) => {
    setTime((t) => ({ ...t, minute: m }));
    if (goodMinute(m) === m) emit({ ...base, hour12: goodHour(time.hour12), minute: m, pm: time.pm });
  };
  const setPm = (pm: boolean) => { setTime((t) => ({ ...t, pm })); emit({ ...base, hour12: goodHour(time.hour12), minute: goodMinute(time.minute), pm }); };
  const pickDay = (day: number) => emit({ year: view.year, month: view.month, day, hour12: goodHour(time.hour12), minute: goodMinute(time.minute), pm: time.pm });

  /** Arrow keys move between the days; Home / End go to the first and last. */
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -7 : e.key === "ArrowDown" ? 7 : 0;
    if (!delta) return;
    const days = Array.from(gridRef.current?.querySelectorAll<HTMLButtonElement>("button[data-day]:not(:disabled)") ?? []);
    const i = days.findIndex((d) => d === document.activeElement);
    const next = days[Math.min(days.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta))];
    if (next) { e.preventDefault(); next.focus(); }
  };

  const tz = timeZoneName();
  const frame = bare
    ? ""
    : `rounded-lg border bg-[var(--color-bg)] ${invalid ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus-visible:border-[var(--color-primary)]"}`;

  return (
    <>
      <button ref={triggerRef} type="button" aria-label={label} aria-haspopup="dialog" aria-expanded={open} disabled={disabled}
              onClick={() => (open ? close() : openPanel())}
              className={`inline-flex h-full min-h-9 min-w-0 flex-1 items-center justify-between gap-2 px-3 text-left text-[13px] outline-none disabled:cursor-not-allowed disabled:opacity-50 ${frame}`}>
        <span className="flex min-w-0 items-center gap-2">
          <CalendarClock size={14} className="shrink-0 text-[var(--color-text-muted)]" aria-hidden />
          <span className={`truncate ${value == null ? "text-[var(--color-text-muted)]" : ""}`}>{value == null ? placeholder : formatPicked(value)}</span>
        </span>
        <ChevronDown size={12} aria-hidden className="shrink-0 text-[var(--color-text-muted)]" style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s" }} />
      </button>

      {open && createPortal(
        <div ref={panelRef} role="dialog" aria-label={`${label}: calendar and time`} onKeyDown={onPanelKey}
             style={{ position: "fixed", zIndex: 9999, width: WIDTH, left: pos.left, top: pos.flipUp ? undefined : pos.top, bottom: pos.flipUp ? window.innerHeight - pos.top : undefined, boxShadow: "0 8px 32px rgba(0,0,0,0.35)" }}
             className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-[13px] text-[var(--color-text)]" data-datetime-panel="">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label="Previous month" disabled={!canPrev} onClick={() => setView((v) => shiftMonth(v.year, v.month, -1))}
                    className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
              <ChevronLeft size={15} aria-hidden />
            </button>
            <span className="text-sm font-semibold" aria-live="polite" data-month-label="">{monthLabel(view.year, view.month)}</span>
            <button type="button" aria-label="Next month" disabled={!canNext} onClick={() => setView((v) => shiftMonth(v.year, v.month, 1))}
                    className="inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
              <ChevronRight size={15} aria-hidden />
            </button>
          </div>
          <div className="grid grid-cols-7 text-center text-[11px] text-[var(--color-text-muted)]" aria-hidden>
            {weekdays.map((w, i) => <span key={i} className="py-1">{w}</span>)}
          </div>
          <div ref={gridRef} role="grid" aria-label={monthLabel(view.year, view.month)} className="grid grid-cols-7 gap-0.5" onKeyDown={onGridKey}>
            {cells.map((day, i) => {
              if (day == null) return <span key={i} className="h-8" />;
              const allowed = dayAllowed(view.year, view.month, day, min, max);
              const selected = !!picked && picked.year === view.year && picked.month === view.month && picked.day === day;
              const isToday = today.year === view.year && today.month === view.month && today.day === day;
              return (
                <button key={i} type="button" data-day={day} disabled={!allowed} aria-pressed={selected} aria-current={isToday ? "date" : undefined}
                        aria-label={new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date(view.year, view.month, day))}
                        onClick={() => pickDay(day)}
                        className={`h-8 cursor-pointer rounded-md text-[13px] tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${selected
                          ? "bg-[var(--color-primary)] font-semibold text-[var(--color-bg)]"
                          : `hover:bg-[var(--color-bg-tertiary)] ${isToday ? "border border-[var(--color-primary)]/60" : ""}`}`}>
                  {day}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-[var(--color-border)] pt-3">
            <span className="text-xs font-medium text-[var(--color-text-muted)]">Time</span>
            <NumberField label={`${label}: hour`} value={time.hour12} min={1} max={12} width={92} onChange={setHour} />
            <span aria-hidden className="text-[var(--color-text-muted)]">:</span>
            <NumberField label={`${label}: minutes`} value={time.minute} min={0} max={59} pad={2} width={92} onChange={setMinute} />
            <div role="radiogroup" aria-label={`${label}: AM or PM`} className="inline-flex h-9 overflow-hidden rounded-lg border border-[var(--color-border)]">
              {([false, true] as const).map((pm) => (
                <button key={String(pm)} type="button" role="radio" aria-checked={time.pm === pm} onClick={() => setPm(pm)}
                        className={`cursor-pointer px-2.5 text-xs font-semibold transition-colors ${time.pm === pm ? "bg-[var(--color-primary)] text-[var(--color-bg)]" : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)]"}`}>
                  {pm ? "PM" : "AM"}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2.5 text-[11px] leading-snug text-[var(--color-text-muted)]">
            {tz ? `In your time zone (${tz}). ` : "In your time zone. "}The receiver sees it in theirs.
          </p>
          <div className="mt-2.5 flex justify-end">
            <button type="button" onClick={close}
                    className="h-8 cursor-pointer rounded-lg bg-[var(--color-primary)] px-4 text-xs font-semibold text-[var(--color-bg)] hover:bg-[var(--color-primary-hover)]">
              Done
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
