import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { UNIT_OPTIONS, type TimeLimit, type TimeUnit } from "../../lib/shareExport";

/**
 * A time the sender sets, or turns off: a choice ("for a set time" / "no end"), and when it is on a whole number with
 * hours or days. Used for how long a share file works and for how long imported items stay.
 */
export function TimeLimitField({ label, hint, value, onChange, onLabel, offLabel, disabled }: {
  label: string;
  hint?: string;
  value: TimeLimit;
  onChange: (v: TimeLimit) => void;
  /** The choice that turns the limit on ("Ends after a time"). */
  onLabel: string;
  /** The choice that turns it off ("No end date"). */
  offLabel: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={label}>
      <span className="text-[13px] font-medium">{label}</span>
      <div className="flex items-center gap-2">
        <Select
          aria-label={`${label}: limit`} disabled={disabled} className="min-w-0 flex-1" triggerStyle={{ minWidth: 0, flex: 1 }}
          value={value.on ? "on" : "off"}
          options={[{ value: "on", label: onLabel }, { value: "off", label: offLabel }]}
          onChange={(v) => onChange({ ...value, on: v === "on" })}
        />
        {value.on && (
          <>
            <Input
              type="number" min={1} step={1} inputMode="numeric" aria-label={`${label}: amount`} disabled={disabled} className="!w-[72px] shrink-0"
              value={Number.isFinite(value.amount) ? value.amount : ""}
              onChange={(e) => onChange({ ...value, amount: e.target.value === "" ? NaN : Number(e.target.value) })}
            />
            <Select
              aria-label={`${label}: unit`} disabled={disabled} className="shrink-0" triggerStyle={{ minWidth: 0, width: 96 }}
              value={value.unit} options={UNIT_OPTIONS}
              onChange={(v) => onChange({ ...value, unit: v as TimeUnit })}
            />
          </>
        )}
      </div>
      {hint && <span className="text-xs text-[var(--color-text-muted)]">{hint}</span>}
    </div>
  );
}
