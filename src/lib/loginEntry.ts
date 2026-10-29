import { DEFAULT_PW_OPTIONS, generateWithOptions } from "./passwordGen";
/** A structured login stored in the vault (file type `login`). */
export interface LoginEntry {
  v: 1;
  kind: "login";
  title: string;
  /** The main site of this login. */
  url: string;
  /** Extra sites the same login works on (e.g. a second domain or regional site). Optional in old entries. */
  urls: string[];
  username: string;
  password: string;
  /** Optional base32 TOTP secret (2-step verification). */
  totp: string;
  notes: string;
}

export const LOGIN_EXT = "login";

export const emptyLogin = (title = ""): LoginEntry => ({
  v: 1, kind: "login", title, url: "", urls: [], username: "", password: "", totp: "", notes: "",
});

export const serializeLogin = (e: LoginEntry): string => JSON.stringify(e);

/** Tolerant parse: unknown/missing fields fall back to empty strings. */
export function parseLogin(raw: string): LoginEntry {
  try {
    const o = JSON.parse(raw) as Partial<LoginEntry>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const urls = Array.isArray(o.urls) ? o.urls.filter((u): u is string => typeof u === "string" && u.trim() !== "").slice(0, 20) : [];
    return { v: 1, kind: "login", title: s(o.title), url: s(o.url), urls, username: s(o.username),
             password: s(o.password), totp: s(o.totp), notes: s(o.notes) };
  } catch {
    return emptyLogin();
  }
}

/** Every site a login applies to: the main `url` first, then `urls`, without blanks or duplicates. */
export function loginUrls(e: Pick<LoginEntry, "url" | "urls">): string[] {
  const seen = new Set<string>();
  return [e.url, ...(e.urls ?? [])].map((u) => u.trim()).filter((u) => u && !seen.has(u.toLowerCase()) && seen.add(u.toLowerCase()));
}

/** Host of a URL or bare domain (`https://Accounts.Google.com/x` → `accounts.google.com`). */
export function hostOf(url: string): string {
  const t = url.trim();
  if (!t) return "";
  try { return new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`).hostname.toLowerCase(); } catch { return ""; }
}

/** Cryptographically random password with at least one of each class (see passwordGen for options). */
export function generatePassword(length = 20, symbols = true): string {
  return generateWithOptions({ ...DEFAULT_PW_OPTIONS, length, symbols });
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
