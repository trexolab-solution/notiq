// Notiq Autofill — password generator for the toolbar popup. Mirrors the desktop app (src/lib/passwordGen.ts):
// same options, defaults and character sets. Pure: no DOM, no chrome.*; unit-tested in test/generator.test.mjs.
// Randomness comes from crypto.getRandomValues with rejection sampling (no modulo bias). Generated passwords
// are never stored: only the OPTIONS are remembered (chrome.storage.local, see popup.js).
(function (g) {
  "use strict";
  if (g.NotiqGen) return;

  const MIN_LENGTH = 8;
  const MAX_LENGTH = 64;
  const DEFAULTS = Object.freeze({ length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: true });
  const SYMBOLS = "!@#$%^&*-_=+?";

  // Clamps the length, coerces the flags and guarantees at least one character class is on.
  function sanitize(raw) {
    const o = Object.assign({}, DEFAULTS, raw && typeof raw === "object" ? raw : {});
    const len = Math.round(Number(o.length));
    const out = {
      length: Number.isFinite(len) ? Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, len)) : DEFAULTS.length,
      lower: !!o.lower, upper: !!o.upper, digits: !!o.digits, symbols: !!o.symbols, avoidAmbiguous: !!o.avoidAmbiguous,
    };
    if (!out.lower && !out.upper && !out.digits && !out.symbols) out.lower = true;
    return out;
  }

  // The enabled character classes, each a string (ambiguous l, I, O, 0, 1 left out on request).
  function pools(o) {
    const amb = o.avoidAmbiguous;
    return [
      ...(o.lower ? [amb ? "abcdefghijkmnpqrstuvwxyz" : "abcdefghijklmnopqrstuvwxyz"] : []),
      ...(o.upper ? [amb ? "ABCDEFGHJKLMNPQRSTUVWXYZ" : "ABCDEFGHIJKLMNOPQRSTUVWXYZ"] : []),
      ...(o.digits ? [amb ? "23456789" : "0123456789"] : []),
      ...(o.symbols ? [SYMBOLS] : []),
    ];
  }

  // Uniform integer in [0, n): 32-bit draws above the largest multiple of n are thrown away.
  // `fillRandom` is crypto.getRandomValues by default (injectable for tests).
  function randomBelow(n, fillRandom) {
    if (!Number.isInteger(n) || n < 1 || n > 0x100000000) throw new RangeError("randomBelow: bad range");
    const fill = fillRandom || ((a) => g.crypto.getRandomValues(a));
    const limit = Math.floor(0x100000000 / n) * n;
    const buf = new Uint32Array(1);
    do { fill(buf); } while (buf[0] >= limit);
    return buf[0] % n;
  }

  // A random password with at least one character of every enabled class.
  function generate(options, fillRandom) {
    const o = sanitize(options);
    const sets = pools(o);
    const all = sets.join("");
    const pick = (set) => set[randomBelow(set.length, fillRandom)];
    const out = sets.map(pick);
    while (out.length < Math.max(o.length, sets.length)) out.push(pick(all));
    for (let i = out.length - 1; i > 0; i--) { // Fisher–Yates
      const j = randomBelow(i + 1, fillRandom);
      const t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out.join("");
  }

  // Strength of a password made with these options: bits of entropy and a label.
  function strength(options) {
    const o = sanitize(options);
    const size = pools(o).join("").length;
    const bits = Math.round(o.length * Math.log2(size));
    const level = bits < 45 ? 0 : bits < 65 ? 1 : bits < 90 ? 2 : 3;
    return { bits, level, label: ["Weak", "Fair", "Strong", "Very strong"][level] };
  }

  const api = Object.freeze({ MIN_LENGTH, MAX_LENGTH, DEFAULTS, sanitize, pools, randomBelow, generate, strength });
  try {
    Object.defineProperty(g, "NotiqGen", { value: api, writable: false, configurable: false, enumerable: false });
  } catch { /* already defined */ }
})(typeof globalThis !== "undefined" ? globalThis : self);
