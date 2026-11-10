import type { LoginMatch } from "../lib/autofill";
import { hostOf, loginUrls } from "../lib/loginEntry";
import { COPY_LABEL, type ApprovedCopy } from "../lib/autofillPopup";

/**
 * Wording of the autofill approval sheet (pure, so it is unit-tested).
 *
 * The sheet only states what Notiq knows about a request: the page host (taken by the extension from the
 * tab URL) and the saved logins. The request carries no scheme and no browser name, so the sheet never
 * claims "https" or names a browser. An exact host match turns the host line green; a subdomain match
 * (saved for `example.com`, page `login.example.com`) is normal and stays quiet. The only warning is the
 * look-alike screen (`promptMachine`'s `warning` stage).
 */

const bare = (h: string) => h.trim().toLowerCase().replace(/^www\./, "");

/** The hosts a login is saved for (its main site and every extra site), deduplicated, without `www.`. */
export function savedHosts(entry: LoginMatch["entry"]): string[] {
  const out: string[] = [];
  for (const u of loginUrls(entry)) {
    const h = bare(hostOf(u));
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

/** True when one of the login's sites is exactly the page host (`www.` ignored). */
export function exactSiteMatch(pageHost: string, entry: LoginMatch["entry"]): boolean {
  const page = bare(pageHost);
  return savedHosts(entry).includes(page);
}

const DAY = 86_400_000;

/** "last used today" / "last used yesterday" / "last used 3 days ago" ("" when never, in this session). */
export function lastUsedText(at: number, now = Date.now()): string {
  if (!at || at > now + 60_000) return "";
  const startOfToday = new Date(now); startOfToday.setHours(0, 0, 0, 0);
  if (at >= startOfToday.getTime()) return "last used today";
  const days = Math.ceil((startOfToday.getTime() - at) / DAY);
  return days <= 1 ? "last used yesterday" : `last used ${days} days ago`;
}

/** The small line under the selected login: "2FA code ready · last used today". */
export function loginMeta(m: LoginMatch, lastUsed: number, now = Date.now()): string {
  const parts: string[] = [];
  if (m.entry.totp.trim()) parts.push("2FA code ready");
  if (m.entry.passkeys?.length) parts.push("passkey");
  const used = lastUsedText(lastUsed, now);
  if (used) parts.push(used);
  const s = parts.join(" · ");
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/** Heading of a login request: "Sign in to GitHub?", "Fill 2-step code for GitHub?", "Copy password for GitHub?". */
export function loginTitle(name: string, req: { copy?: ApprovedCopy; intent?: string }): string {
  if (req.copy) return `Copy ${COPY_LABEL[req.copy]} for ${name}?`;
  if (req.intent === "code") return `Fill 2-step code for ${name}?`;
  return `Sign in to ${name}?`;
}

/** Short label of the primary button (the account row already says who). */
export function loginActionLabel(req: { copy?: ApprovedCopy; intent?: string }): string {
  if (req.copy) return `Copy ${COPY_LABEL[req.copy]}`;
  return req.intent === "code" ? "Fill code" : "Fill";
}

/**
 * Shift+Enter on Fill also copies the 2-step code: only for a plain login fill (not a copy request) of a
 * login that has a 2FA secret.
 */
export function canFillAndCopyCode(m: LoginMatch | undefined, req: { copy?: ApprovedCopy }): boolean {
  return !!m && !req.copy && !!m.entry.totp.trim();
}
