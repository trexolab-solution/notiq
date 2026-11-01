import { invoke } from "@tauri-apps/api/core";
import type { HealthInput } from "./vaultHealth";

/**
 * Optional breached-password check (Have I Been Pwned "Pwned Passwords", k-anonymity). Off by default.
 * Each password is SHA-1 hashed here; only the first 5 hex characters of the hash are sent (by the Rust command
 * `breach_check_ranges`, which takes prefixes only). The returned suffix list is compared locally. Neither the
 * passwords nor full hashes are stored, logged or returned — the result is just `rel → times seen`.
 */

export type BreachSuffixes = Map<string, number>;
interface RangeResult { prefix: string; hits: { suffix: string; count: number }[] }

/** Session-only cache: prefix → breached suffixes (a prefix with no hits is cached as an empty map). */
const cache = new Map<string, BreachSuffixes>();
export const clearBreachCache = () => cache.clear();

/** Prefixes per invoke — keeps progress moving without a request per prefix. */
const CHUNK = 40;

export class BreachCheckError extends Error {
  constructor(public readonly kind: "offline" | "service", message: string) { super(message); }
}

export const BREACH_OFFLINE_MESSAGE = "Couldn't check: offline";

function toError(e: unknown): BreachCheckError {
  const m = typeof e === "string" ? e : e instanceof Error ? e.message : "";
  return m === "offline" || m === ""
    ? new BreachCheckError("offline", BREACH_OFFLINE_MESSAGE)
    : new BreachCheckError("service", "Couldn't check: the breach service didn't respond");
}

async function sha1Upper(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * Returns `rel → times seen in breaches` for logins whose password was found (others are absent).
 * Throws BreachCheckError when the service can't be reached.
 */
export async function checkBreaches(
  inputs: HealthInput[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, number>> {
  const byRel: { rel: string; prefix: string; suffix: string }[] = [];
  for (const inp of inputs) {
    const pw = inp.entry.password;
    if (!pw) continue;
    const h = await sha1Upper(pw);
    byRel.push({ rel: inp.rel, prefix: h.slice(0, 5), suffix: h.slice(5) });
  }
  const missing = [...new Set(byRel.map((x) => x.prefix))].filter((p) => !cache.has(p));
  const total = missing.length;
  onProgress?.(0, total);
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    let res: RangeResult[];
    try { res = await invoke<RangeResult[]>("breach_check_ranges", { prefixes: chunk }); }
    catch (e) { throw toError(e); }
    for (const p of chunk) cache.set(p, new Map());
    for (const r of res) {
      const m = new Map<string, number>();
      for (const h of r.hits) if (h.count > 0) m.set(h.suffix.toUpperCase(), h.count);
      cache.set(r.prefix.toUpperCase(), m);
    }
    onProgress?.(Math.min(total, i + CHUNK), total);
  }
  const out = new Map<string, number>();
  for (const x of byRel) {
    const n = cache.get(x.prefix)?.get(x.suffix);
    if (n) out.set(x.rel, n);
  }
  return out;
}
