import { EXCEPTION, EXTRA, SECOND_LEVEL, WILDCARD } from "./publicSuffixData";

/**
 * Public-suffix helpers (offline, embedded table — see publicSuffixData.ts).
 * A public suffix is where anyone can register names (`com`, `co.uk`, `github.io`);
 * the registrable domain is the suffix plus one label (`bbc.co.uk`).
 */

let rules: Set<string> | null = null;
const wild = new Set(WILDCARD);
const except = new Set(EXCEPTION);

function ruleSet(): Set<string> {
  if (rules) return rules;
  rules = new Set(EXTRA);
  for (const [tld, list] of Object.entries(SECOND_LEVEL)) {
    for (const l of list.split(" ")) if (l) rules.add(`${l}.${tld}`);
  }
  return rules;
}

/** Lowercase, no trailing dot, no port, no IPv6 brackets. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h.slice(1);
  }
  // A single colon means host:port (more than one colon is a bare IPv6 address).
  if ((h.match(/:/g) ?? []).length === 1) h = h.slice(0, h.indexOf(":"));
  return h.replace(/\.+$/, "");
}

export function isIpAddress(host: string): boolean {
  const h = normalizeHost(host);
  if (h.includes(":")) return true; // IPv6
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

/** `localhost` or a name under it (`app.localhost`). */
export const isLocalhost = (host: string) => /(^|\.)localhost$/.test(normalizeHost(host));

/** Is this exact name a rule of the table (or the default single-label rule)? */
function isRule(name: string): boolean {
  if (!name) return false;
  if (except.has(name)) return false;
  if (!name.includes(".")) return true;
  if (ruleSet().has(name)) return true;
  const dot = name.indexOf(".");
  return wild.has(name.slice(dot + 1));
}

/** The public suffix of `host` (`www.bbc.co.uk` → `co.uk`), or "" for an empty host / IP address. */
export function publicSuffix(host: string): string {
  const h = normalizeHost(host);
  if (!h || isIpAddress(h)) return "";
  const labels = h.split(".");
  // Longest matching rule wins: scan from the full name down to the TLD.
  for (let i = 0; i < labels.length; i++) {
    const cand = labels.slice(i).join(".");
    // An exception rule (`!city.kawasaki.jp`) makes its parent the suffix.
    if (except.has(cand)) return cand.slice(cand.indexOf(".") + 1);
    if (isRule(cand)) return cand;
  }
  return labels[labels.length - 1];
}

/** True when `host` itself is a public suffix (nobody owns it). */
export function isPublicSuffix(host: string): boolean {
  const h = normalizeHost(host);
  return !!h && !isIpAddress(h) && publicSuffix(h) === h;
}

/**
 * The registrable domain (`login.bbc.co.uk` → `bbc.co.uk`), or null for an IP address,
 * `localhost`, an empty host, or a host that is itself a public suffix.
 */
export function registrableDomain(host: string): string | null {
  const h = normalizeHost(host);
  if (!h || isIpAddress(h) || isLocalhost(h)) return null;
  const suffix = publicSuffix(h);
  if (suffix === h) return null;
  const rest = h.slice(0, h.length - suffix.length - 1);
  const label = rest.split(".").pop();
  return label ? `${label}.${suffix}` : null;
}

/**
 * Does a page on `pageHost` belong to a login saved for `savedHost`? Ports are ignored.
 * - the exact host always matches;
 * - IP addresses and `localhost` match only exactly;
 * - a page subdomain matches only when the saved host is a registrable domain or a
 *   subdomain of one — never when the saved host is itself a public suffix
 *   (a login saved for `co.uk` or `github.io` must not match every site under it).
 */
export function siteMatches(pageHost: string, savedHost: string): boolean {
  const p = normalizeHost(pageHost);
  const s = normalizeHost(savedHost);
  if (!p || !s) return false;
  if (p === s) return true;
  if (isIpAddress(s) || isIpAddress(p) || isLocalhost(s) || isLocalhost(p)) return false;
  if (!registrableDomain(s)) return false;
  return p.endsWith(`.${s}`);
}
