import { PW_MAX_LENGTH, PW_MIN_LENGTH, sanitizePwOptions, type PwOptions } from "../../lib/passwordGen";

const CLASSES: { key: "lower" | "upper" | "digits" | "symbols"; label: string; sample: string }[] = [
  { key: "lower",   label: "Lowercase", sample: "abc" },
  { key: "upper",   label: "Uppercase", sample: "ABC" },
  { key: "digits",  label: "Numbers",   sample: "123" },
  { key: "symbols", label: "Symbols",   sample: "!@#" },
];

/** Length slider + character-class checkboxes; shared by the generate popup and Settings. */
export function PasswordOptionsForm({ value, onChange }: { value: PwOptions; onChange: (o: PwOptions) => void }) {
  const set = (patch: Partial<PwOptions>) => onChange(sanitizePwOptions({ ...value, ...patch }));
  const onlyOne = CLASSES.filter((c) => value[c.key]).length === 1;

  return (
    <div className="pw-form">
      <label className="pw-length">
        <span className="pw-label">Length</span>
        <input
          type="range" min={PW_MIN_LENGTH} max={PW_MAX_LENGTH} value={value.length}
          aria-label="Password length"
          onChange={(e) => set({ length: Number(e.target.value) })}
        />
        <span className="pw-length-value">{value.length}</span>
      </label>

      <div className="pw-grid" role="group" aria-label="Characters to include">
        {CLASSES.map((c) => (
          <label key={c.key} className="pw-check">
            <input
              type="checkbox" checked={value[c.key]}
              disabled={value[c.key] && onlyOne} // keep at least one class on
              onChange={(e) => set({ [c.key]: e.target.checked })}
            />
            <span>{c.label}</span>
            <code>{c.sample}</code>
          </label>
        ))}
      </div>

      <label className="pw-check">
        <input type="checkbox" checked={value.avoidAmbiguous} onChange={(e) => set({ avoidAmbiguous: e.target.checked })} />
        <span>Avoid look-alike characters</span>
        <code>l I O 0 1</code>
      </label>
    </div>
  );
}
