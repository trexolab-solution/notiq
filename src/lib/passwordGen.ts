/** Password generator used by Login entries (options are remembered per device, see vaultPrefs). */

export interface PwOptions {
  length: number;
  lower: boolean;
  upper: boolean;
  digits: boolean;
  symbols: boolean;
  /** Leave out look-alike characters (l, I, O, 0, 1). */
  avoidAmbiguous: boolean;
}

export const PW_MIN_LENGTH = 8;
export const PW_MAX_LENGTH = 64;

export const DEFAULT_PW_OPTIONS: PwOptions = {
  length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true,
};

const SYMBOLS = "!@#$%^&*-_=+?";

function pools(o: PwOptions): string[] {
  const amb = o.avoidAmbiguous;
  return [
    ...(o.lower ? [amb ? "abcdefghijkmnpqrstuvwxyz" : "abcdefghijklmnopqrstuvwxyz"] : []),
    ...(o.upper ? [amb ? "ABCDEFGHJKLMNPQRSTUVWXYZ" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ"] : []),
    ...(o.digits ? [amb ? "23456789" : "0123456789"] : []),
    ...(o.symbols ? [SYMBOLS] : []),
  ];
}

/** Clamps the length and guarantees at least one character class is on. */
export function sanitizePwOptions(raw: Partial<PwOptions> | null | undefined): PwOptions {
  const o = { ...DEFAULT_PW_OPTIONS, ...(raw ?? {}) };
  const length = Math.round(Number(o.length));
  const out: PwOptions = {
    length: Number.isFinite(length) ? Math.min(PW_MAX_LENGTH, Math.max(PW_MIN_LENGTH, length)) : DEFAULT_PW_OPTIONS.length,
    lower: !!o.lower, upper: !!o.upper, digits: !!o.digits, symbols: !!o.symbols,
    avoidAmbiguous: !!o.avoidAmbiguous,
  };
  if (!out.lower && !out.upper && !out.digits && !out.symbols) out.lower = true;
  return out;
}

function randomBelow(n: number): number {
  // Rejection sampling: no modulo bias.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % n;
}

/** Cryptographically random password with at least one character of every enabled class. */
export function generateWithOptions(options: Partial<PwOptions>): string {
  const o = sanitizePwOptions(options);
  const sets = pools(o);
  const all = sets.join("");
  const pick = (set: string) => set[randomBelow(set.length)];
  const out = sets.map(pick);
  while (out.length < Math.max(o.length, sets.length)) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { // Fisher–Yates
    const j = randomBelow(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}
