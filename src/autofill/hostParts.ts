import { registrableDomain } from "../lib/publicSuffix";

/**
 * Splits a page host for display: `login.accounts.example.co.uk` → prefix `login.accounts.`,
 * site `example.co.uk`. The site (the part that decides who owns the page) is shown bold, the
 * subdomains quieter, so `example.com.evil.io` reads as `evil.io`. IPs, `localhost` and hosts
 * without a registrable domain are shown whole.
 */
export function splitHost(host: string): { prefix: string; site: string } {
  const h = host.trim().toLowerCase();
  const reg = registrableDomain(h);
  if (!reg || reg === h || !h.endsWith(`.${reg}`)) return { prefix: "", site: h };
  return { prefix: h.slice(0, h.length - reg.length), site: reg };
}
