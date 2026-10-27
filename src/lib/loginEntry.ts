/** A structured login stored in the vault (file type `login`). */
export interface LoginEntry {
  v: 1;
  kind: "login";
  title: string;
  /** Sites this login applies to; the first is the main one. */
  url: string;
  username: string;
  password: string;
  /** Optional base32 TOTP secret (2-step verification). */
  totp: string;
  notes: string;
}

export const LOGIN_EXT = "login";

export const emptyLogin = (title = ""): LoginEntry => ({
  v: 1, kind: "login", title, url: "", username: "", password: "", totp: "", notes: "",
});

export const serializeLogin = (e: LoginEntry): string => JSON.stringify(e);

/** Tolerant parse: unknown/missing fields fall back to empty strings. */
export function parseLogin(raw: string): LoginEntry {
  try {
    const o = JSON.parse(raw) as Partial<LoginEntry>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    return { v: 1, kind: "login", title: s(o.title), url: s(o.url), username: s(o.username),
             password: s(o.password), totp: s(o.totp), notes: s(o.notes) };
  } catch {
    return emptyLogin();
  }
}

/** Host of a URL or bare domain (`https://Accounts.Google.com/x` → `accounts.google.com`). */
export function hostOf(url: string): string {
  const t = url.trim();
  if (!t) return "";
  try { return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return ""; }
}

const SETS = {
  lower: "abcdefghijkmnopqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digit: "23456789",
  symbol: "!@#$%^&*-_=+?",
};

/** Cryptographically random password with at least one of each class. */
export function generatePassword(length = 20, symbols = true): string {
  const pools = [SETS.lower, SETS.upper, SETS.digit, ...(symbols ? [SETS.symbol] : [])];
  const all = pools.join("");
  const pick = (set: string) => {
    // Rejection sampling: no modulo bias.
    const limit = Math.floor(0x100000000 / set.length) * set.length;
    const buf = new Uint32Array(1);
    do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
    return set[buf[0] % set.length];
  };
  const out = pools.map(pick);
  while (out.length < Math.max(length, pools.length)) out.push(pick(all));
  for (let i = out.length - 1; i > 0; i--) { // Fisher–Yates
    const j = Math.floor((() => { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] / 0x100000000; })() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}

function base32Decode(s: string): Uint8Array | null {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  if (!clean) return null;
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = A.indexOf(ch);
    if (i < 0) return null;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

/** RFC 6238 time-based one-time password (SHA-1, 30 s step). Null if the secret is invalid. */
export async function totpCode(secret: string, nowMs = Date.now(), digits = 6): Promise<string | null> {
  const key = base32Decode(secret);
  if (!key || key.length === 0) return null;
  const counter = Math.floor(nowMs / 1000 / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setUint32(4, counter);
  new DataView(msg.buffer).setUint32(0, Math.floor(counter / 0x100000000));
  const k = await crypto.subtle.importKey("raw", key.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", k, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

/** Seconds left in the current TOTP window. */
export const totpRemaining = (nowMs = Date.now()) => 30 - (Math.floor(nowMs / 1000) % 30);
