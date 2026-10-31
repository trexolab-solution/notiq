import { totpCode } from "./loginEntry";
import { indexOfAccount, type LoginMatch } from "./autofill";
import { copySecretTimed } from "./secureCopy";

/**
 * The browser extension's toolbar popup (0.9.0): `list`, `copy` and `open` (see "Popup ops" in
 * src-tauri/src/autofill.rs for the gating). Answered by the autofill prompt window.
 *
 * * `list`: titles and usernames of the logins that match the page host (never a secret, never another
 *   site's login), only while the vault is unlocked, without a prompt.
 * * `copy`: Notiq copies the value itself (`copySecretTimed`: kept out of clipboard history, wiped after the
 *   user's setting); the reply only says that it worked. A password or 2FA code is approved like a fill.
 */

export type CopyWhat = "username" | "password" | "code";
/** The copies that need the user's approval (the username is already shown in the popup's list). */
export type ApprovedCopy = Exclude<CopyWhat, "username">;

export const validCopyWhat = (v: unknown): CopyWhat | undefined =>
  v === "username" || v === "password" || v === "code" ? v : undefined;

/** Words for the approval window: "copy the password of a saved login". */
export const COPY_LABEL: Record<CopyWhat, string> = { username: "username", password: "password", code: "2FA code" };

export interface ListedAccount { account: string; title: string; username: string; totp: boolean }

/** At most this many logins in one list (Rust caps it again). */
export const MAX_LISTED = 50;

/** The `list` reply for host-matched logins: no password, no code, no notes. */
export function listReply(matches: LoginMatch[]): { ok: true; accounts: ListedAccount[] } {
  const accounts = matches
    .filter((m) => !!m.rel)
    .slice(0, MAX_LISTED)
    .map((m) => ({
      account: m.rel as string,
      title: (m.entry.title || m.entry.url || "").slice(0, 200),
      username: (m.entry.username || "").slice(0, 512),
      totp: !!m.entry.totp && !!m.entry.totp.trim(),
    }));
  return { ok: true, accounts };
}

/** Only the login the popup named (from its list), or none: a popup copy never falls back to another login. */
export function copyTargets(matches: LoginMatch[], account: unknown): LoginMatch[] {
  const i = indexOfAccount(matches, account);
  return i >= 0 ? [matches[i]] : [];
}

/** The value a copy puts on the clipboard (null: the login has none). */
export async function copyValue(m: LoginMatch, what: CopyWhat): Promise<string | null> {
  if (what === "username") return m.entry.username || null;
  if (what === "password") return m.entry.password || null;
  return m.entry.totp && m.entry.totp.trim() ? await totpCode(m.entry.totp) : null;
}

const LABEL: Record<CopyWhat, string> = { username: "Username", password: "Password", code: "2FA code" };

/**
 * Copies `what` of `m` with the app's secret-safe clipboard and answers the extension WITHOUT the value:
 * `{ok, copied, clearAfter}` (seconds, 0 = never) or `{error}`.
 */
export async function copyForExtension(m: LoginMatch, what: CopyWhat) {
  let value: string | null;
  try { value = await copyValue(m, what); } catch { value = null; }
  if (!value) return { error: what === "code" ? "no_code" : "empty" };
  const secs = await copySecretTimed(value, LABEL[what], { quiet: true });
  return secs === null ? { error: "failed" } : { ok: true, copied: what, clearAfter: secs };
}

export interface PopupDeps {
  /** Tells the backend the vault folder (the prompt window has no file-system access). */
  prepare: () => Promise<unknown>;
  unlocked: () => Promise<boolean>;
  scan: (host: string) => Promise<LoginMatch[]>;
  /** The "vault is locked" error the vault commands throw. */
  lockedError: unknown;
}

async function withUnlockedMatches<T>(deps: PopupDeps, host: string, then: (m: LoginMatch[]) => Promise<T> | T) {
  try {
    await deps.prepare();
    if (!(await deps.unlocked())) return { error: "locked" };
    return await then(await deps.scan(host));
  } catch (err) {
    return { error: err === deps.lockedError ? "locked" : "failed" };
  }
}

/** Answers `list` silently: never shows the window, never offers to unlock. */
export const answerList = (deps: PopupDeps, host: string) => withUnlockedMatches(deps, host, listReply);

/** Answers a username copy silently (it is already in the popup's list): unlocked vault and a matching login only. */
export const answerUsernameCopy = (deps: PopupDeps, host: string, account: unknown) =>
  withUnlockedMatches(deps, host, async (matches) => {
    const [m] = copyTargets(matches, account);
    return m ? await copyForExtension(m, "username") : { error: "stale" };
  });
