import { isIpAddress, isLocalhost, normalizeHost, publicSuffix, registrableDomain, siteMatches } from "./publicSuffix";

/**
 * Look-alike ("fake site") detection for autofill. Pure and offline.
 * Used only after a request found NO matching login: if the page host looks like
 * a site the user has a login for, the app warns (and still reveals nothing).
 */

export type LookalikeReason = "punycode" | "confusable" | "homoglyph" | "tld" | "spelling" | "subdomain";

export interface Lookalike { saved: string; reason: LookalikeReason }

export const LOOKALIKE_REASON_TEXT: Record<LookalikeReason, string> = {
  punycode: "uses international (punycode) characters",
  confusable: "uses look-alike characters from another alphabet",
  homoglyph: "swaps look-alike letters or digits",
  tld: "has the same name with a different ending",
  spelling: "is spelled almost the same",
  subdomain: "puts the real name in front of another domain",
};

// ─── Punycode (RFC 3492) decoding ─────────────────────────────────────────────

const BASE = 36, T_MIN = 1, T_MAX = 26, SKEW = 38, DAMP = 700;

function adapt(delta: number, numPoints: number, first: boolean): number {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) >> 1) { d = Math.floor(d / (BASE - T_MIN)); k += BASE; }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

/** Decodes one punycode label body (without `xn--`); null when malformed. */
export function punycodeDecode(input: string): string | null {
  const out: number[] = [];
  const basic = Math.max(0, input.lastIndexOf("-"));
  for (let j = 0; j < basic; j++) {
    const c = input.charCodeAt(j);
    if (c >= 0x80) return null;
    out.push(c);
  }
  let n = 128, bias = 72, i = 0;
  for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length;) {
    const oldi = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (idx >= input.length) return null;
      const cp = input.charCodeAt(idx++);
      const digit = cp >= 48 && cp <= 57 ? cp - 22 : cp >= 65 && cp <= 90 ? cp - 65 : cp >= 97 && cp <= 122 ? cp - 97 : BASE;
      if (digit >= BASE) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      w *= BASE - t;
      if (w > 0x7fffffff) return null;
    }
    const len = out.length + 1;
    bias = adapt(i - oldi, len, oldi === 0);
    n += Math.floor(i / len);
    i %= len;
    if (n > 0x10ffff) return null;
    out.splice(i++, 0, n);
  }
  try { return String.fromCodePoint(...out); } catch { return null; }
}

/** `xn--…` labels decoded to Unicode; other labels unchanged. */
export function decodeLabel(label: string): string {
  if (!label.startsWith("xn--")) return label;
  return punycodeDecode(label.slice(4)) ?? label;
}

// ─── Skeletons ────────────────────────────────────────────────────────────────

/** Common non-Latin characters that render like Latin letters (Cyrillic, Greek, a few others). */
const CONFUSABLE: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "ѕ": "s", "і": "i", "ї": "i", "ј": "j", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w",
  "ɡ": "g", "ı": "i", "ł": "l", "ø": "o", "đ": "d", "ħ": "h", "ß": "ss",
  "α": "a", "β": "b", "ε": "e", "η": "n", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u",
  "χ": "x", "ω": "w",
};

/** Look-alike ASCII characters and sequences folded together (applied after CONFUSABLE). */
const ASCII_FOLD: [RegExp, string][] = [
  [/0/g, "o"], [/[1i|!]/g, "l"], [/3/g, "e"], [/5/g, "s"], [/\$/g, "s"], [/@/g, "a"],
  [/rn/g, "m"], [/vv/g, "w"], [/cl/g, "d"],
];

const hasNonAscii = (s: string) => /[^\x00-\x7f]/.test(s);

/** A string with look-alike characters folded together: `pаypa1` and `paypal` share a skeleton. */
export function skeleton(s: string): string {
  let t = s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = [...t].map((c) => CONFUSABLE[c] ?? c).join("");
  for (const [re, to] of ASCII_FOLD) t = t.replace(re, to);
  return t;
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Allowed spelling distance for a label length: short names would flag far too many unrelated sites. */
const maxDistance = (len: number) => (len >= 6 ? 2 : len >= 4 ? 1 : 0);

interface Parts { host: string; reg: string; suffix: string; label: string }

function parts(host: string): Parts | null {
  const h = normalizeHost(host);
  if (!h || isIpAddress(h) || isLocalhost(h)) return null;
  const reg = registrableDomain(h);
  if (!reg) return null;
  const suffix = publicSuffix(h);
  return { host: h, reg, suffix, label: reg.slice(0, reg.length - suffix.length - 1) };
}

/**
 * The saved host that `pageHost` imitates, or null. Returns null whenever the page
 * actually matches one of the saved hosts, or is on the same registrable domain.
 */
export function lookalikeOf(pageHost: string, savedHosts: string[]): Lookalike | null {
  const page = parts(pageHost);
  if (!page) return null;
  if (savedHosts.some((s) => siteMatches(page.host, s))) return null;

  const pRaw = page.label;
  const pPuny = page.host.split(".").some((l) => l.startsWith("xn--"));
  const pLabel = decodeLabel(pRaw);
  const pSkel = skeleton(pLabel);

  let best: Lookalike | null = null;
  const rank: LookalikeReason[] = ["punycode", "confusable", "homoglyph", "subdomain", "tld", "spelling"];
  const consider = (cand: Lookalike) => {
    if (!best || rank.indexOf(cand.reason) < rank.indexOf(best.reason)) best = cand;
  };

  for (const saved of savedHosts) {
    const s = parts(saved);
    if (!s || s.reg === page.reg) continue;
    const sSkel = skeleton(s.label);
    const skelDist = editDistance(pSkel, sSkel, 2);

    if (pPuny && skelDist <= maxDistance(s.label.length)) consider({ saved: s.host, reason: "punycode" });
    else if (hasNonAscii(pLabel) && skelDist === 0) consider({ saved: s.host, reason: "confusable" });
    else if (pLabel !== s.label && skelDist === 0) consider({ saved: s.host, reason: "homoglyph" });
    else if (page.host.startsWith(`${s.reg}.`) || page.host.includes(`.${s.reg}.`)) consider({ saved: s.host, reason: "subdomain" });
    else if (pLabel === s.label && page.suffix !== s.suffix) consider({ saved: s.host, reason: "tld" });
    else {
      const limit = maxDistance(Math.min(pLabel.length, s.label.length));
      const d = limit > 0 ? editDistance(pLabel, s.label, limit) : limit + 1;
      if (d > 0 && d <= limit) consider({ saved: s.host, reason: "spelling" });
    }
  }
  return best;
}
