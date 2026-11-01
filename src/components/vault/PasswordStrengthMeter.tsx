import { assessMasterPassword } from "../../lib/masterPassword";

const COLORS = [
  "var(--color-danger)",
  "var(--color-danger)",
  "var(--color-warning)",
  "var(--color-success)",
  "var(--color-success)",
];

/** Strength bar + label + one hint for a NEW master password. Renders nothing while the field is empty. */
export function PasswordStrengthMeter({ password }: { password: string }) {
  if (!password) return null;
  const r = assessMasterPassword(password);
  const color = COLORS[r.score];
  return (
    <div className="mt-1.5" data-testid="pw-strength">
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i} className="h-1 flex-1 rounded-full"
            style={{ background: i <= Math.max(r.score, 1) ? color : "var(--color-border)" }}
          />
        ))}
      </div>
      <div className="flex justify-between gap-2 mt-1 text-[11px] text-[var(--color-text-muted)]">
        <span aria-live="polite" style={{ color }}>Strength: {r.label}</span>
        <span>{r.hint}</span>
      </div>
    </div>
  );
}
