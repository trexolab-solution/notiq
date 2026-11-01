/**
 * Passkeys (experimental) in the autofill prompt window: find the passkeys a sign-in may use, and store a new
 * passkey on a Login entry. The key pair, the RP ID checks and every signature are Rust's (see
 * `src-tauri/src/passkey.rs` and the "Passkeys" block of `autofill.rs`); Rust also re-checks the vault before it
 * answers the browser, so nothing here can make it sign for another site.
 */
import { listVaultFiles, LOGINS_FOLDER, vaultRoot, type LoginMatch } from "./autofill";
import { emptyLogin, LOGIN_EXT, parseLogin, serializeLogin } from "./loginEntry";
import { parsePasskey, passkeyUsable, withPasskey, type StoredPasskey } from "./passkeyEntry";
import { vaultList, vaultMkdir, vaultReadFile, vaultWriteFile, VAULT_CHANGED_EVENT } from "./vault";
import { childNames, joinRel, nameError, normRel, toFull, uniqueName } from "./vaultTree";

/** A saved passkey a sign-in may use, with the login that holds it. */
export interface PasskeyMatch { path: string; rel: string; title: string; passkey: StoredPasskey }

/** A `passkey_create` request as the prompt window receives it from Rust. */
export interface PasskeyCreateReq {
  id: string; host: string; rpId: string; rpName: string; userName: string; displayName: string;
  /** Credential ids the site already has for this user (base64url). */
  exclude: string[];
  /** The new credential (private key included), made by Rust. */
  passkey: StoredPasskey;
}

/** A `passkey_get` request. `allow`: credential ids the site accepts (empty = any of its passkeys). */
export interface PasskeyGetReq { id: string; host: string; rpId: string; allow: string[] }

const idList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^[A-Za-z0-9_-]{1,1400}$/.test(x)).slice(0, 64) : [];
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The create request from the event payload, or null when the record doesn't match the request. */
export function toCreateReq(p: Record<string, unknown>): PasskeyCreateReq | null {
  const passkey = parsePasskey(p.passkey);
  const rpId = str(p.rpId);
  if (!passkey || !rpId || passkey.rpId !== rpId || typeof p.id !== "string" || !str(p.host)) return null;
  return {
    id: p.id, host: str(p.host), rpId, rpName: str(p.rpName), userName: str(p.userName), displayName: str(p.displayName),
    exclude: idList(p.exclude), passkey,
  };
}

/** The get request from the event payload, or null. */
export function toGetReq(p: Record<string, unknown>): PasskeyGetReq | null {
  const rpId = str(p.rpId);
  if (!rpId || typeof p.id !== "string" || !str(p.host)) return null;
  return { id: p.id, host: str(p.host), rpId, allow: idList(p.allow) };
}

/** Every live login's passkeys for exactly `rpId` (and in `allow` when the site names credentials). */
export async function scanPasskeys(rpId: string, allow: readonly string[]): Promise<PasskeyMatch[]> {
  const out: PasskeyMatch[] = [];
  for (const { path, rel } of await listVaultFiles()) {
    try {
      const f = await vaultReadFile(path);
      if (f.ext !== LOGIN_EXT) continue;
      const entry = parseLogin(f.content);
      for (const passkey of entry.passkeys ?? []) {
        if (passkeyUsable(passkey, rpId, allow)) out.push({ path, rel, title: entry.title || entry.url || rpId, passkey });
      }
    } catch { /* unreadable entry: skip */ }
  }
  return out.sort((a, b) => b.passkey.created - a.passkey.created);
}

/** Does the vault already hold one of the credentials the site listed in excludeCredentials? */
export async function hasExcludedPasskey(rpId: string, exclude: readonly string[]): Promise<boolean> {
  return exclude.length > 0 && (await scanPasskeys(rpId, exclude)).length > 0;
}

/** The login a new passkey goes to by default: same user name, else the only match; -1 = a new login. */
export function defaultPasskeyTarget(logins: LoginMatch[], userName: string): number {
  const u = userName.trim().toLowerCase();
  const same = u ? logins.findIndex((m) => m.entry.username.trim().toLowerCase() === u) : -1;
  if (same >= 0) return same;
  return logins.length === 1 ? 0 : -1;
}

/** Entry name for a login made for a passkey: the RP's name, else the RP ID. */
export function passkeyLoginName(req: Pick<PasskeyCreateReq, "rpName" | "rpId">): string {
  const clean = req.rpName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 80).trim();
  return clean && !nameError(clean) ? clean : req.rpId;
}

/**
 * Stores the passkey on `target` (re-read from the vault so nothing else on it changes) or on a new login under
 * Logins/ named after the site, with the site's address and the user name (no password).
 */
export async function savePasskey(target: LoginMatch | null, req: PasskeyCreateReq): Promise<void> {
  if (target) {
    const cur = parseLogin((await vaultReadFile(target.path)).content);
    await vaultWriteFile(target.path, serializeLogin({ ...cur, passkeys: withPasskey(cur.passkeys, req.passkey) }), LOGIN_EXT);
  } else {
    const root = await vaultRoot();
    const items = await vaultList();
    if (!items.some((i) => i.dir && normRel(i.rel).toLowerCase() === LOGINS_FOLDER.toLowerCase())) {
      await vaultMkdir(toFull(root, LOGINS_FOLDER));
    }
    const name = uniqueName(passkeyLoginName(req), childNames(items, LOGINS_FOLDER));
    const login = { ...emptyLogin(name), url: `https://${req.rpId}`, username: req.userName, passkeys: [req.passkey] };
    await vaultWriteFile(toFull(root, joinRel(LOGINS_FOLDER, `${name}.nqv`)), serializeLogin(login), LOGIN_EXT);
  }
  window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
}

/** The reply that lets Rust sign with the picked passkey. Never send it without the user's Allow. */
export const passkeyReply = (m: PasskeyMatch) => ({ ok: true, account: normRel(m.rel), credentialId: m.passkey.credentialId });
