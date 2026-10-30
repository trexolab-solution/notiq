/** Pure helpers for the payment-card vault entry (no React; unit-tested). */

export const digitsOnly = (s: string) => s.replace(/\D/g, "");

/** Luhn checksum; false for anything that isn't 12–19 digits. */
export function luhnValid(number: string): boolean {
  const d = digitsOnly(number);
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/** Card network guessed from the number's prefix (label only — never used for validation). */
export function cardBrand(number: string): string | null {
  const d = digitsOnly(number);
  if (!d) return null;
  if (/^3[47]/.test(d)) return "American Express";
  if (/^3(0[0-5]|[689])/.test(d)) return "Diners Club";
  if (/^35(2[89]|[3-8])/.test(d)) return "JCB";
  if (/^4/.test(d)) return "Visa";
  if (/^(5[1-5]|222[1-9]|22[3-9]\d|2[3-6]\d\d|27[01]\d|2720)/.test(d)) return "Mastercard";
  if (/^(6011|65|64[4-9])/.test(d)) return "Discover";
  if (/^62/.test(d)) return "UnionPay";
  if (/^(5[06-9]|6\d)/.test(d)) return "Maestro";
  return null;
}

/** Groups the digits for display: Amex 4-6-5, everything else in fours. Max 19 digits. */
export function formatCardNumber(raw: string): string {
  const d = digitsOnly(raw).slice(0, 19);
  if (/^3[47]/.test(d)) return [d.slice(0, 4), d.slice(4, 10), d.slice(10, 15)].filter(Boolean).join(" ");
  return d.replace(/(\d{4})(?=\d)/g, "$1 ");
}

/** Typing aid for MM/YY: keeps up to 4 digits and inserts the slash once the year starts ("1225" → "12/25"). */
export function formatExpiry(raw: string): string {
  const d = digitsOnly(raw).slice(0, 4);
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d;
}

/** Problem with an MM/YY expiry, or null when it's empty or fine. `now` is injectable for tests. */
export function expiryError(expiry: string, now = new Date()): string | null {
  const t = expiry.trim();
  if (!t) return null;
  const m = /^(\d{2})\/(\d{2})$/.exec(t);
  if (!m) return "Use the MM/YY format, e.g. 08/27";
  const month = Number(m[1]);
  if (month < 1 || month > 12) return "Month must be 01 to 12";
  const year = 2000 + Number(m[2]);
  const cur = now.getFullYear() * 12 + now.getMonth(); // month index 0-based
  if (year * 12 + (month - 1) < cur) return "This card has expired";
  return null;
}

// ─── Browser autofill ────────────────────────────────────────────────────────

/** "•••• 4242": the last four digits only (nothing at all for a number too short to mask). */
export function maskCardNumber(number: string): string {
  const d = digitsOnly(number);
  return d.length >= 8 ? `•••• ${d.slice(-4)}` : "••••";
}

/** "08/27" → month "08", year "2027"; null when it isn't a valid MM/YY (an expired card still parses). */
export function expiryParts(expiry: string): { month: string; year: string } | null {
  const m = /^(\d{2})\/(\d{2})$/.exec(expiry.trim());
  if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
  return { month: m[1], year: `20${m[2]}` };
}

/** What the browser extension receives for one card. Empty strings stand for fields the card doesn't have. */
export interface CardFill { name: string; number: string; exp_month: string; exp_year: string; csc: string }

/**
 * The fill payload for a stored card, or null when its number can't be filled (fewer than 12 or more than
 * 19 digits). The extension re-validates every field with the same rules before it touches the page.
 */
export function cardFill(fields: Record<string, string | undefined>): CardFill | null {
  const number = digitsOnly(fields.number ?? "");
  if (number.length < 12 || number.length > 19) return null;
  const exp = expiryParts(fields.expiry ?? "");
  const csc = digitsOnly(fields.cvv ?? "");
  return {
    name: (fields.cardholder ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 100),
    number,
    exp_month: exp?.month ?? "",
    exp_year: exp?.year ?? "",
    csc: csc.length >= 3 && csc.length <= 4 ? csc : "",
  };
}

/** True once the month after the card's expiry month has begun; false without an expiry. */
export function cardExpired(f: Pick<CardFill, "exp_month" | "exp_year">, now = new Date()): boolean {
  if (!f.exp_month || !f.exp_year) return false;
  return Number(f.exp_year) * 12 + Number(f.exp_month) - 1 < now.getFullYear() * 12 + now.getMonth();
}

/** Soft hint under the card number (never blocks saving). */
export function cardNumberHint(number: string): string | null {
  const d = digitsOnly(number);
  if (!d) return null;
  if (d.length < 12) return null; // still typing
  return luhnValid(d) ? null : "This number doesn't pass the card checksum — check for a typo";
}
