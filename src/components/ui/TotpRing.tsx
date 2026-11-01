/**
 * Countdown ring for a live 2-step code: a full ring at the start of the 30-second step that empties
 * as the code nears expiry, drawn in the warning colour once `low`. Decorative (aria-hidden): callers
 * say the seconds left in text or in the accessible name. Shared by the quick search window and the
 * autofill window's details view.
 */
export function TotpRing({ left, period = 30, size = 16, stroke = 2, low = false, className = "" }: {
  /** Seconds left in the current step. */
  left: number;
  period?: number;
  size?: number;
  stroke?: number;
  low?: boolean;
  className?: string;
}) {
  const c = size / 2;
  const r = c - stroke;
  const len = 2 * Math.PI * r;
  const frac = Math.min(1, Math.max(0, left / period));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={`shrink-0 ${className}`}
         data-totp-ring="">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
      <circle
        cx={c} cy={c} r={r} fill="none" strokeWidth={stroke} strokeLinecap="round"
        stroke={low ? "var(--color-warning)" : "var(--color-primary)"}
        strokeDasharray={len}
        strokeDashoffset={len * (1 - frac)}
        transform={`rotate(-90 ${c} ${c})`}
      />
    </svg>
  );
}
