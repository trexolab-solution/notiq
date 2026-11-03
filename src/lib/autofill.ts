import { invoke } from "@tauri-apps/api/core";
import { ensureVaultDir } from "./vaultDir";
import { vaultList, vaultMkdir, vaultReadFile, vaultWriteFile, VAULT_CHANGED_EVENT } from "./vault";
import { childNames, joinRel, nameError, normRel, toFull, uniqueName } from "./vaultTree";
import { emptyLogin, hostOf, LOGIN_EXT, loginUrls, parseLogin, serializeLogin, totpCode, type LoginEntry } from "./loginEntry";
import { siteMatches } from "./publicSuffix";
import { lookalikeOf, type Lookalike } from "./lookalike";
import { parseSecret, type SecretEntry } from "./secretEntry";
import { cardFill, type CardFill } from "./cardEntry";
import { IDENTITY_EXT, identityFill, type IdentityFill } from "./identityEntry";

const CARD_EXT = "card";

/**
 * `path` is the full path, `rel` the vault-relative one (forward slashes) used as the protocol's `account`.
 * `updated`: when the entry was last modified (ms, from the vault listing), used to order save candidates.
 */
export interface LoginMatch { path: string; rel?: string; entry: LoginEntry; updated?: number }

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
export const vaultRoot = async () => (await rootResolver()).replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Requests are routed to the small autofill prompt window. The main window only handles the ones Rust
 * sends it when that window is unavailable, marked `fallback: true`; it must ignore everything else so a
 * request is never handled twice.
 */
export function isFallbackRequest(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && (payload as { fallback?: unknown }).fallback === true;
}

export async function listVaultFiles(): Promise<{ path: string; rel: string; updated: number }[]> {
  const root = await vaultRoot();
  return (await vaultList())
    .filter((i) => !i.dir && /\.nqv$/i.test(i.rel))
    .map((i) => ({ path: `${root}/${i.rel}`, rel: normRel(i.rel), updated: i.updated }));
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
  for (const { path, rel, updated } of await listVaultFiles()) {
    try {
      const f = await vaultReadFile(path);
      if (f.ext !== LOGIN_EXT) continue;
      const entry = parseLogin(f.content);
      if (entryMatches(pageHost, entry)) matches.push({ path, rel, entry, updated });
      for (const u of loginUrls(entry)) { const h = hostOf(u); if (h) savedHosts.add(h); }
    } catch { /* unreadable file: skip */ }
  }
  return { matches, lookalike: matches.length ? null : lookalikeOf(pageHost, [...savedHosts]) };
}

// ─── Payment cards ───────────────────────────────────────────────────────────

/** A saved card that can be filled (`fill` is what the extension would receive). */
export interface CardMatch { path: string; rel: string; entry: SecretEntry; fill: CardFill }

/**
 * Every card in the vault with a fillable number, sorted by title. Cards are not tied to a site, so
 * the page host plays no part here: the user always picks the card in the approval window.
 * Only files the listing marks as cards are decrypted.
 */
export async function scanCards(): Promise<CardMatch[]> {
  const root = await vaultRoot();
  const out: CardMatch[] = [];
  for (const i of await vaultList()) {
    if (i.dir || i.ext !== CARD_EXT || !/\.nqv$/i.test(i.rel)) continue;
    const path = `${root}/${i.rel}`;
    try {
      const f = await vaultReadFile(path);
      if (f.ext !== CARD_EXT) continue;
      const entry = parseSecret(CARD_EXT, f.content);
      const fill = cardFill(entry.fields);
      if (fill) out.push({ path, rel: normRel(i.rel), entry, fill });
    } catch { /* unreadable file: skip */ }
  }
  return out.sort((a, b) => cardTitle(a).localeCompare(cardTitle(b)));
}

/** The card's name in lists: its title, else the cardholder, else "Card". */
export const cardTitle = (c: Pick<CardMatch, "entry">) => c.entry.title.trim() || c.entry.fields.cardholder?.trim() || "Card";

/** The reply that releases a card to the extension. Never send it without the user picking the card. */
export const cardReply = (c: CardMatch) => ({ ok: true, title: cardTitle(c).slice(0, 200), ...c.fill });

// ─── Identities (name / contact / address for forms) ────────────────────────

/** A saved identity that can be filled (`fill` is what the extension would receive). */
export interface IdentityMatch { path: string; rel: string; entry: SecretEntry; fill: IdentityFill }

/**
 * Every identity in the vault with something to fill, sorted by title. Like cards, identities are not
 * tied to a site: the user always picks one in the approval window, which names the site that gets it.
 * Only files the listing marks as identities are decrypted.
 */
export async function scanIdentities(): Promise<IdentityMatch[]> {
  const root = await vaultRoot();
  const out: IdentityMatch[] = [];
  for (const i of await vaultList()) {
    if (i.dir || i.ext !== IDENTITY_EXT || !/\.nqv$/i.test(i.rel)) continue;
    const path = `${root}/${i.rel}`;
    try {
      const f = await vaultReadFile(path);
      if (f.ext !== IDENTITY_EXT) continue;
      const entry = parseSecret(IDENTITY_EXT, f.content);
      const fill = identityFill(entry.fields);
      if (fill) out.push({ path, rel: normRel(i.rel), entry, fill });
    } catch { /* unreadable file: skip */ }
  }
  return out.sort((a, b) => identityTitle(a).localeCompare(identityTitle(b)));
}

/** The identity's name in lists: its title, else its file name, else "Identity". */
export const identityTitle = (m: Pick<IdentityMatch, "entry" | "rel">) =>
  m.entry.title.trim() || (m.rel.split("/").pop() ?? "").replace(/\.nqv$/i, "").trim() || "Identity";

/** Index of the identity the extension asked for (`account`, case-insensitive), else 0. */
export function indexOfIdentity(list: Pick<IdentityMatch, "rel">[], account: unknown): number {
  const a = validAccount(account);
  if (!a) return 0;
  const k = list.findIndex((m) => normRel(m.rel).toLowerCase() === a.toLowerCase());
  return k < 0 ? 0 : k;
}

/** The reply that releases an identity to the extension. Never send it without the user picking it. */
export const identityReply = (m: IdentityMatch) => ({ ok: true, title: identityTitle(m).slice(0, 200), ...m.fill });

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

/** Forget every trusted site (vault locked, window closed to the tray, app quitting), and which logins were used. */
export function clearTrust(): void {
  trusted.clear();
  scheduleTrustSweep();
  clearLoginUsage();
}

// ─── Which login was filled last (orders the "Update which login?" choice) ───

/**
 * When each login was last filled into a browser, keyed by its full path (lower case). In memory only
 * and per window: entry names are encrypted in the vault, so they are never written anywhere in the
 * clear. Forgotten when the vault locks (see `clearTrust`).
 */
const lastUsed = new Map<string, number>();
const usageKey = (m: Pick<LoginMatch, "path">) => m.path.replace(/\\/g, "/").toLowerCase();

export function markLoginUsed(m: Pick<LoginMatch, "path">, now = Date.now()): void {
  lastUsed.set(usageKey(m), now);
  if (lastUsed.size > 200) lastUsed.delete(lastUsed.keys().next().value as string); // oldest first
}
export const loginLastUsed = (m: Pick<LoginMatch, "path">): number => lastUsed.get(usageKey(m)) ?? 0;
export function clearLoginUsage(): void { lastUsed.clear(); }

export function trustedHosts(now = Date.now()): string[] {
  return [...trusted.entries()].filter(([, u]) => u > now).map(([h]) => h);
}

/** Credentials for one login. Never send these for a login that doesn't match the requesting host. */
export async function credentialsFor(m: LoginMatch) {
  const code = m.entry.totp ? await totpCode(m.entry.totp) : null;
  return { username: m.entry.username, password: m.entry.password, title: m.entry.title, ...(code ? { code } : {}) };
}

// ─── Custom fields filled by name (0.9.0) ─────────────────────────────────────

/** One custom field as the extension receives it with a login fill. */
export interface CustomFillField { name: string; value: string; secret: boolean }

/** Longest custom-field value sent to the extension (longer ones, e.g. pasted notes, are not filled). */
export const MAX_CUSTOM_FILL_VALUE = 1024;

/**
 * The login's custom fields for the extension to fill by name ("Customer ID", "PIN" …): only fields with
 * a name and a value, at most 20, values up to 1 KB, control characters other than tab / newline excluded.
 * Sent only with a normal (password) fill of this very login, which is host-matched like its password;
 * the extension fills secret ones only on that site's own pages. Never part of a code-only fill.
 */
export function customFillFields(e: Pick<LoginEntry, "custom">): CustomFillField[] {
  const out: CustomFillField[] = [];
  for (const f of e.custom ?? []) {
    const name = f.label.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
    if (!name || !f.value || f.value.length > MAX_CUSTOM_FILL_VALUE) continue;
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(f.value)) continue;
    out.push({ name: name.slice(0, 60), value: f.value, secret: f.secret === true });
    if (out.length >= 20) break;
  }
  return out;
}

// ─── Code-only fills (a separate 2FA page) ───────────────────────────────────

/** What the extension asked for: `"code"` = only the TOTP code of the matching login (Rust validated it). */
export type FillIntent = "code";
export const validIntent = (v: unknown): FillIntent | undefined => (v === "code" ? "code" : undefined);

const hasTotp = (m: LoginMatch) => !!m.entry.totp && !!m.entry.totp.trim();

/** The logins a fill may use: for a code-only fill, just those with a 2FA secret. */
export function matchesForIntent(matches: LoginMatch[], intent?: FillIntent): LoginMatch[] {
  return intent === "code" ? matches.filter(hasTotp) : matches;
}

/**
 * The reply to an approved fill. A code-only fill gets the current TOTP code (with the username and
 * title so the user can tell which login it was) and never the password.
 */
export async function fillReply(m: LoginMatch, intent?: FillIntent) {
  markLoginUsed(m);
  if (intent !== "code") {
    const fields = customFillFields(m.entry);
    return { ok: true, ...(await credentialsFor(m)), ...(fields.length ? { fields } : {}) };
  }
  const code = hasTotp(m) ? await totpCode(m.entry.totp) : null;
  return code ? { ok: true, username: m.entry.username, title: m.entry.title, code } : { error: "no_code" };
}

// ─── Saving a login captured in the browser ──────────────────────────────────

/**
 * `current`: a change-password form's current (old) password, when the page had one. It only helps find the
 * login to update (the one that still holds it); it is never written.
 */
export interface SaveRequest { id: string; host: string; url: string; username: string; password: string; title: string; current?: string }
/**
 * `target`: the login an update writes to. `candidates`: every saved login with this username on the
 * site, best first (set for an update, and kept when the user switches to "Save as new" so they can go
 * back). With more than one candidate the prompt lets the user pick which login to update.
 */
export interface SavePlan { kind: "unchanged" | "update" | "create"; target?: LoginMatch; candidates?: LoginMatch[] }

/**
 * Decides what saving `req` should do given the logins already stored for the
 * site: same username (case-insensitive; empty only equals empty) with the same
 * password → nothing; different password → update; otherwise create.
 * `existing` is expected to be the host-matched list from `findLogins`.
 * Change-password forms may send `current` (the old password): without a username, the logins that still
 * hold that password are the ones to update; with one, they come first among that username's logins.
 * Update candidates are ordered: still holding `current` first, then most recently filled (`lastUsedOf`),
 * then most recently modified, then in vault order; the first one is the pre-selected target.
 */
export function planSave(
  existing: LoginMatch[],
  req: { username: string; password: string; current?: string },
  lastUsedOf: (m: LoginMatch) => number = loginLastUsed,
): SavePlan {
  const u = req.username.trim().toLowerCase();
  const current = req.current || "";
  let same = existing.filter((m) => m.entry.username.trim().toLowerCase() === u);
  if (!u && current) {
    const holding = existing.filter((m) => m.entry.password === current);
    if (holding.length) same = holding;
  }
  if (same.some((m) => m.entry.password === req.password)) return { kind: "unchanged" };
  if (!same.length) return { kind: "create" };
  const candidates = same
    .map((m, i) => ({ m, i, cur: current && m.entry.password === current ? 1 : 0, used: lastUsedOf(m) || 0, updated: m.updated ?? 0 }))
    .sort((a, b) => b.cur - a.cur || b.used - a.used || b.updated - a.updated || a.i - b.i)
    .map((x) => x.m);
  return { kind: "update", target: candidates[0], candidates };
}

/**
 * The answer to the extension's `save_check` (should the page offer Save, Update or nothing?), from the plan:
 * `none` for an unchanged login (no offer at all), `update` with how many logins it could go to (the prompt
 * lets the user pick when there are several), else `save`. Holds no vault data.
 */
export function saveCheckReply(plan: SavePlan): { ok: true; action: "none" | "update" | "save"; choices: number } {
  if (plan.kind === "unchanged") return { ok: true, action: "none", choices: 0 };
  if (plan.kind === "update") return { ok: true, action: "update", choices: Math.min(20, Math.max(1, plan.candidates?.length ?? 1)) };
  return { ok: true, action: "save", choices: 0 };
}

/** The plan after the user picks update candidate `index` (ignored when out of range or without candidates). */
export function pickSaveTarget(plan: SavePlan, index: number): SavePlan {
  const c = plan.candidates?.[index];
  return c ? { ...plan, kind: "update", target: c } : plan;
}

/** "Save as new" (`asNew`) or back to updating the selected login. Only for plans with update candidates. */
export function setSaveAsNew(plan: SavePlan, asNew: boolean): SavePlan {
  if (!plan.candidates?.length) return plan;
  return { ...plan, kind: asNew ? "create" : "update", target: plan.target ?? plan.candidates[0] };
}

/** True when the prompt should offer a choice of login to update ("Update: <entry> ▾" + "Save as new"). */
export const hasSaveChoice = (plan: SavePlan) => (plan.candidates?.length ?? 0) > 1;

/** A candidate's name in the "Update" list: its title (else its site), plus its folder path when titles repeat. */
export function saveCandidateLabel(m: LoginMatch, all: LoginMatch[]): string {
  const title = (m.entry.title || m.entry.url || "Login").trim();
  const dup = all.some((o) => o !== m && (o.entry.title || o.entry.url || "Login").trim().toLowerCase() === title.toLowerCase());
  if (!dup) return title;
  const where = (m.rel ?? m.path).replace(/\\/g, "/").replace(/\.nqv$/i, "");
  return `${title} (${where})`;
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
export type ExtensionBrowser = "edge" | "chrome" | "brave" | "firefox";
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
