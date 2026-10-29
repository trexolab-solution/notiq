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

/** Soft hint under the card number (never blocks saving). */
export function cardNumberHint(number: string): string | null {
  const d = digitsOnly(number);
  if (!d) return null;
  if (d.length < 12) return null; // still typing
  return luhnValid(d) ? null : "This number doesn't pass the card checksum — check for a typo";
}
