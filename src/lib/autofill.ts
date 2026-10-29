import { invoke } from "@tauri-apps/api/core";
import { ensureVaultDir } from "./vaultDir";
import { vaultList, vaultMkdir, vaultReadFile, vaultWriteFile, VAULT_CHANGED_EVENT } from "./vault";
import { childNames, joinRel, nameError, normRel, toFull, uniqueName } from "./vaultTree";
import { emptyLogin, hostOf, LOGIN_EXT, loginUrls, parseLogin, serializeLogin, totpCode, type LoginEntry } from "./loginEntry";
import { siteMatches } from "./publicSuffix";
import { lookalikeOf, type Lookalike } from "./lookalike";

/** `path` is the full path, `rel` the vault-relative one (forward slashes) used as the protocol's `account`. */
export interface LoginMatch { path: string; rel?: string; entry: LoginEntry }

/**
 * `login.example.com` matches a login saved for `example.com`, never the reverse.
 * Public-suffix aware: a login saved for `co.uk` matches no `.co.uk` site; IP addresses and
 * `localhost` match only exactly; ports are ignored. See `siteMatches` in publicSuffix.ts.
 */
export function hostMatches(pageHost: string, savedHost: string): boolean {
  return siteMatches(pageHost, savedHost);
}

/** True when any of the login's sites (`url` and every extra `urls` entry) matches `pageHost`. */
export function entryMatches(pageHost: string, entry: Pick<LoginEntry, "url" | "urls">): boolean {
  return loginUrls(entry).some((u) => hostMatches(pageHost, hostOf(u)));
}

/**
 * Where the vault lives. The main window uses `ensureVaultDir` (it may create a folder the user
 * picked); the autofill prompt window has no file-system permission and swaps in a resolver that
 * only tells the backend the folder (see `setVaultRootResolver`).
 */
let rootResolver: () => Promise<string> = ensureVaultDir;
export function setVaultRootResolver(f: () => Promise<string>): void { rootResolver = f; }
const vaultRoot = async () => (await rootResolver()).replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Requests are routed to the small autofill prompt window. The main window only handles the ones Rust
 * sends it when that window is unavailable, marked `fallback: true`; it must ignore everything else so a
 * request is never handled twice.
 */
export function isFallbackRequest(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { fallback?: unknown }).fallback === true;
}

async function listVaultFiles(): Promise<{ path: string; rel: string }[]> {
  const root = await vaultRoot();
  return (await vaultList())
    .filter((i) => !i.dir && /\.nqv$/i.test(i.rel))
    .map((i) => ({ path: `${root}/${i.rel}`, rel: normRel(i.rel) }));
}

/** Saved logins whose site matches `pageHost`. Requires an unlocked vault. */
export async function findLogins(pageHost: string): Promise<LoginMatch[]> {
  return (await scanLogins(pageHost)).matches;
}

/**
 * Host-matched logins plus, when there are none, the saved site `pageHost` imitates (if any).
 * The look-alike is only used to warn the user in the app: it never changes what is sent.
 */
export async function scanLogins(pageHost: string): Promise<{ matches: LoginMatch[]; lookalike: Lookalike | null }> {
  const matches: LoginMatch[] = [];
  const savedHosts = new Set<string>();
  for (const { path, rel } of await listVaultFiles()) {
    try {
      const f = await vaultReadFile(path);
      if (f.ext !== LOGIN_EXT) continue;
      const entry = parseLogin(f.content);
      if (entryMatches(pageHost, entry)) matches.push({ path, rel, entry });
      for (const u of loginUrls(entry)) { const h = hostOf(u); if (h) savedHosts.add(h); }
    } catch { /* unreadable file: skip */ }
  }
  return { matches, lookalike: matches.length ? null : lookalikeOf(pageHost, [...savedHosts]) };
}

/** The in-app warning shown when a fill request came from a possible fake site. */
export const lookalikeWarning = (pageHost: string, l: Lookalike) =>
  `Blocked a possible fake site: ${pageHost} looks like ${l.saved}`;

// ─── Fewer prompts: requested account + per-site trust window ────────────────

/** Mirrors the native host's check: ≤ 512 chars, no control chars, not absolute, no `..`. Empty → null. */
export function validAccount(account: unknown): string | null {
  if (typeof account !== "string" || !account) return null;
  if (account.length > 512 || /[\u0000-\u001f\u007f]/.test(account)) return null;
  if (/^[\\/]/.test(account) || account.includes(":") || account.includes("..")) return null;
  return normRel(account);
}

const relOf = (m: LoginMatch) => normRel(m.rel ?? "");

/** Index of the match for `account` among host-matched logins (case-insensitive), or -1. */
export function indexOfAccount(matches: LoginMatch[], account: unknown): number {
  const a = validAccount(account);
  if (!a) return -1;
  const want = a.toLowerCase();
  return matches.findIndex((m) => !!m.rel && relOf(m).toLowerCase() === want);
}

export interface ChooseOption { account: string; title: string; username: string }

/** What a trusted site gets without a dialog. Only host-matched logins are ever considered or listed. */
export type TrustedDecision =
  | { kind: "fill"; match: LoginMatch }
  | { kind: "choose"; options: ChooseOption[] }
  | { kind: "no_match" };

export function decideTrusted(matches: LoginMatch[], account: unknown): TrustedDecision {
  if (!matches.length) return { kind: "no_match" };
  const i = indexOfAccount(matches, account);
  if (i >= 0) return { kind: "fill", match: matches[i] };
  if (matches.length === 1) return { kind: "fill", match: matches[0] };
  return {
    kind: "choose",
    options: matches.map((m) => ({ account: relOf(m), title: m.entry.title || m.entry.url, username: m.entry.username })),
  };
}

export const TRUST_MS = 5 * 60 * 1000;
const trusted = new Map<string, number>(); // page host -> until (ms)
let trustTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleTrustSweep() {
  if (trustTimer) clearTimeout(trustTimer);
  trustTimer = null;
  if (!trusted.size) return;
  const next = Math.min(...trusted.values());
  trustTimer = setTimeout(() => {
    const now = Date.now();
    for (const [h, until] of trusted) if (until <= now) trusted.delete(h);
    scheduleTrustSweep();
  }, Math.max(0, next - Date.now()));
}

/**
 * "Allow this site for 5 minutes". Kept in memory only, keyed by the exact page host:
 * trusting `example.com` does not trust `sub.example.com` or `evil-example.com`.
 */
export function trustHost(host: string, now = Date.now()): number {
  const until = now + TRUST_MS;
  trusted.set(host.toLowerCase(), until);
  scheduleTrustSweep();
  return until;
}

export function isTrusted(host: string, now = Date.now()): boolean {
  const key = host.toLowerCase();
  const until = trusted.get(key);
  if (until === undefined) return false;
  if (until <= now) { trusted.delete(key); return false; }
  return true;
}

/** Forget every trusted site (vault locked, window closed to the tray, app quitting). */
export function clearTrust(): void {
  trusted.clear();
  scheduleTrustSweep();
}

export function trustedHosts(now = Date.now()): string[] {
  return [...trusted.entries()].filter(([, u]) => u > now).map(([h]) => h);
}

/** Credentials for one login. Never send these for a login that doesn't match the requesting host. */
export async function credentialsFor(m: LoginMatch) {
  const code = m.entry.totp ? await totpCode(m.entry.totp) : null;
  return { username: m.entry.username, password: m.entry.password, title: m.entry.title, ...(code ? { code } : {}) };
}

// ─── Saving a login captured in the browser ──────────────────────────────────

export interface SaveRequest { id: string; host: string; url: string; username: string; password: string; title: string }
export interface SavePlan { kind: "unchanged" | "update" | "create"; target?: LoginMatch }

/**
 * Decides what saving `req` should do given the logins already stored for the
 * site: same username (case-insensitive; empty only equals empty) with the same
 * password → nothing; different password → update; otherwise create.
 * `existing` is expected to be the host-matched list from `findLogins`.
 */
export function planSave(existing: LoginMatch[], req: { username: string; password: string }): SavePlan {
  const u = req.username.trim().toLowerCase();
  const same = existing.filter((m) => m.entry.username.trim().toLowerCase() === u);
  if (same.some((m) => m.entry.password === req.password)) return { kind: "unchanged" };
  if (same.length) return { kind: "update", target: same[0] };
  return { kind: "create" };
}

export const LOGINS_FOLDER = "Logins";

/** Entry name from a page title: invalid file-name characters removed, host as fallback. */
export function defaultLoginName(title: string, host: string): string {
  const clean = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return clean || host;
}

/**
 * Writes the login to the vault (create under Logins/, or replace only the password).
 * `refreshTabs: false` skips refreshing the open vault tabs (the autofill prompt window has no tabs;
 * it tells the main window through the `vault:entries-changed` event instead).
 */
export async function saveLogin(
  plan: SavePlan,
  req: { url: string; host: string; username: string; password: string; title: string },
  name?: string,
  { refreshTabs = true }: { refreshTabs?: boolean } = {},
): Promise<"saved" | "updated"> {
  let status: "saved" | "updated";
  if (plan.kind === "update" && plan.target) {
    const f = await vaultReadFile(plan.target.path);
    const cur = parseLogin(f.content);
    await vaultWriteFile(plan.target.path, serializeLogin({ ...cur, password: req.password }), LOGIN_EXT);
    status = "updated";
  } else {
    const root = await vaultRoot();
    const items = await vaultList();
    if (!items.some((i) => i.dir && normRel(i.rel).toLowerCase() === LOGINS_FOLDER.toLowerCase())) {
      await vaultMkdir(toFull(root, LOGINS_FOLDER));
    }
    const base = name !== undefined && !nameError(name) ? name.trim() : defaultLoginName(req.title, req.host);
    const unique = uniqueName(base, childNames(items, LOGINS_FOLDER));
    let origin = req.url;
    try { origin = new URL(req.url).origin; } catch { /* keep as given */ }
    await vaultWriteFile(
      toFull(root, joinRel(LOGINS_FOLDER, `${unique}.nqv`)),
      serializeLogin({ ...emptyLogin(unique), url: origin, username: req.username, password: req.password }),
      LOGIN_EXT,
    );
    status = "saved";
  }
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
  if (!refreshTabs) return status;
  // Lazy import keeps this module (and its pure helpers) testable without the app store.
  const { useAppStore } = await import("../store");
  await useAppStore.getState().refreshVaultTabs();
  return status;
}

// ─── Bridge status / repair (Settings → Browser autofill) ────────────────────

export interface BrowserRegStatus {
  name: string;
  installed: boolean;
  registered: boolean;
  manifest_path: string | null;
  path_matches_current_exe: boolean;
  ids_ok: boolean;
}
export interface AutofillStatus {
  browsers: BrowserRegStatus[];
  ipc_ok: boolean;
  extension_last_seen_ms: number | null;
  last_request: { at_ms: number; host: string; outcome: string } | null;
  native_host_exe: string;
  is_dev: boolean;
  note: string | null;
  supported: boolean;
}

export const autofillStatus = () => invoke<AutofillStatus>("autofill_status");
export const autofillRepair = () => invoke<AutofillStatus>("autofill_repair");

/** Folder with the extension files that ships with Notiq (what "Load unpacked" should point at), or null. */
export const autofillExtensionDir = () => invoke<string | null>("autofill_extension_dir");
export const autofillOpenExtensionDir = () => invoke<void>("autofill_open_extension_dir");
export type ExtensionBrowser = "edge" | "chrome" | "brave";
/** Opens the browser's extensions page (edge://extensions, chrome://extensions, …). */
export const autofillOpenBrowserExtensions = (browser: ExtensionBrowser) =>
  invoke<void>("autofill_open_browser_extensions", { browser });

export type BrowserRegState = "ok" | "missing" | "other_copy" | "outdated";

/** One browser's registration as a single state for the status table. */
export function browserRegState(b: BrowserRegStatus): BrowserRegState {
  if (!b.registered) return "missing";
  if (!b.path_matches_current_exe) return "other_copy";
  if (!b.ids_ok) return "outdated";
  return "ok";
}

export const BROWSER_REG_LABEL: Record<BrowserRegState, string> = {
  ok: "Registered",
  missing: "Not registered",
  other_copy: "Points to another copy of Notiq",
  outdated: "Registered (extension list out of date)",
};
