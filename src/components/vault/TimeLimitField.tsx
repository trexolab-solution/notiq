import { useState } from "react";
import { DateTimePicker } from "../ui/DateTimePicker";
import { NumberField } from "../ui/NumberField";
import { Select } from "../ui/Select";
import { atRange, limitMax, limitProblem, MODE_OPTIONS, UNIT_OPTIONS, withMode, type LimitMode, type TimeLimit, type TimeUnit } from "../../lib/shareExport";

/** The dropdown buttons inside the group: no border or background of their own, the group draws them. */
const BARE = { border: "none", background: "transparent", borderRadius: 0, minWidth: 0, padding: "0 12px", height: "100%" } as const;

/**
 * A time the sender sets, as ONE group: how ("after a set time", "on a date and time", "never"), and then what that
 * needs inside the same border: a whole number and hours or days, or a date and time picked from a calendar. A wrong
 * value turns the group red and says why under it; otherwise the hint is shown.
 */
export function TimeLimitField({ label, what, hint, value, onChange, offLabel = "Never", disabled }: {
  label: string;
  /** Names the field in its error ("File expiry"). */
  what: string;
  hint?: string;
  value: TimeLimit;
  onChange: (v: TimeLimit) => void;
  /** The words for "never" ("Never"). */
  offLabel?: string;
  disabled?: boolean;
}) {
  // Read once per render: the calendar's range and the check both move with the clock.
  const [now] = useState(() => Date.now());
  const clock = Date.now() > now + 60_000 ? Date.now() : now;
  const problem = limitProblem(value, what, clock);
  const { min, max } = atRange(clock);
  const options = MODE_OPTIONS.map((o) => (o.value === "never" ? { ...o, label: offLabel } : o));
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <span className="text-[13px] font-medium">{label}</span>
      <div className={`flex h-9 items-stretch rounded-lg border bg-[var(--color-bg)] ${problem ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus-within:border-[var(--color-primary)]"}`}
           data-time-group="" data-invalid={problem ? "" : undefined}>
        <div className={value.mode === "never" ? "flex-1" : "w-[168px] shrink-0"}>
          <Select
            aria-label={`${label}: when`} disabled={disabled} className="h-full w-full" triggerStyle={{ ...BARE, width: "100%" }}
            value={value.mode} options={options}
            onChange={(v) => onChange(withMode(value, v as LimitMode, Date.now()))}
          />
        </div>
        {value.mode === "after" && (
          <>
            <span aria-hidden className="w-px self-stretch bg-[var(--color-border)]" />
            <NumberField bare label={`${label}: amount`} disabled={disabled} value={value.amount} min={1} max={limitMax(value.unit)} width={118}
                         onChange={(amount) => onChange({ ...value, amount })} />
            <span aria-hidden className="w-px self-stretch bg-[var(--color-border)]" />
            <div className="flex-1">
              <Select
                aria-label={`${label}: unit`} disabled={disabled} className="h-full w-full" triggerStyle={{ ...BARE, width: "100%" }}
                value={value.unit} options={UNIT_OPTIONS}
                onChange={(v) => onChange({ ...value, unit: v as TimeUnit })}
              />
            </div>
          </>
        )}
        {value.mode === "at" && (
          <>
            <span aria-hidden className="w-px self-stretch bg-[var(--color-border)]" />
            <DateTimePicker bare label={`${label}: date and time`} disabled={disabled} value={value.at} min={min} max={max}
                            onChange={(at) => onChange({ ...value, at })} />
          </>
        )}
      </div>
      {problem
        ? <span role="alert" className="text-xs text-[var(--color-danger)]">{problem}</span>
        : hint && <span className="text-xs text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}
