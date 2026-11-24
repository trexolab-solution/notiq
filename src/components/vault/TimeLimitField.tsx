import { NumberField } from "../ui/NumberField";
import { Select } from "../ui/Select";
import { limitMax, limitProblem, UNIT_OPTIONS, type TimeLimit, type TimeUnit } from "../../lib/shareExport";

/** The dropdown buttons inside the group: no border or background of their own, the group draws them. */
const BARE = { border: "none", background: "transparent", borderRadius: 0, minWidth: 0, padding: "0 12px", height: 36 } as const;

/**
 * A time the sender sets, or turns off, as ONE group: a choice ("a set time" / "never"), and when it is a set time a
 * whole number and hours or days, side by side inside the same border. A wrong number turns the group red and says why
 * under it; otherwise the hint is shown.
 */
export function TimeLimitField({ label, what, hint, value, onChange, onLabel, offLabel, disabled }: {
  label: string;
  /** Names the field in its error ("File expiry"). */
  what: string;
  hint?: string;
  value: TimeLimit;
  onChange: (v: TimeLimit) => void;
  /** The choice that turns the limit on ("A set time"). */
  onLabel: string;
  /** The choice that turns it off ("Never"). */
  offLabel: string;
  disabled?: boolean;
}) {
  const problem = limitProblem(value, what);
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <span className="text-[13px] font-medium">{label}</span>
      <div className={`flex h-9 items-stretch overflow-hidden rounded-lg border bg-[var(--color-bg)] ${problem ? "border-[var(--color-danger)]" : "border-[var(--color-border)] focus-within:border-[var(--color-primary)]"}`}
           data-time-group="" data-invalid={problem ? "" : undefined}>
        <Select
          aria-label={`${label}: when`} disabled={disabled} className="min-w-0 flex-1" triggerStyle={{ ...BARE, flex: 1 }}
          value={value.on ? "on" : "off"}
          options={[{ value: "on", label: onLabel }, { value: "off", label: offLabel }]}
          onChange={(v) => onChange({ ...value, on: v === "on" })}
        />
        {value.on && (
          <>
            <span aria-hidden className="w-px self-stretch bg-[var(--color-border)]" />
            <NumberField bare label={`${label}: amount`} disabled={disabled} value={value.amount} min={1} max={limitMax(value.unit)} width={118}
                         onChange={(amount) => onChange({ ...value, amount })} />
            <span aria-hidden className="w-px self-stretch bg-[var(--color-border)]" />
            <Select
              aria-label={`${label}: unit`} disabled={disabled} className="shrink-0" triggerStyle={{ ...BARE, width: 100 }}
              value={value.unit} options={UNIT_OPTIONS}
              onChange={(v) => onChange({ ...value, unit: v as TimeUnit })}
            />
          </>
        )}
      </div>
      {problem
        ? <span role="alert" className="text-xs text-[var(--color-danger)]">{problem}</span>
        : hint && <span className="text-xs text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}
