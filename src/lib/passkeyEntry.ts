/**
 * Passkeys (experimental) stored on a Login entry: `login.passkeys = [StoredPasskey]`.
 *
 * The key pair is made by the app's Rust side (`src-tauri/src/passkey.rs`, ES256) and the record reaches the
 * autofill prompt window with the approval request; the prompt stores it on the Login the user picks. Signing
 * happens in Rust, which reads `key` back from the vault. Pure helpers only (no Tauri, no vault access).
 */
export interface StoredPasskey {
  /** The WebAuthn RP ID (a domain), e.g. `github.com`. A passkey is only ever used for exactly this RP ID. */
  rpId: string;
  /** base64url (no padding). */
  credentialId: string;
  /** The RP's user.id, base64url. */
  userHandle: string;
  userName: string;
  displayName: string;
  rpName: string;
  /** PKCS#8 DER private key, base64url. Secret: never shown, never sent to the extension. */
  key: string;
  /** COSE algorithm: -7 (ES256). */
  alg: number;
  /** Unix ms. */
  created: number;
}

export const MAX_PASSKEYS = 50;
const B64U = /^[A-Za-z0-9_-]+$/;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)*$/;

const text = (v: unknown, max = 256) =>
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "";

/** One stored passkey, or null when anything essential is missing or malformed. */
export function parsePasskey(v: unknown): StoredPasskey | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const rpId = typeof o.rpId === "string" ? o.rpId : "";
  const credentialId = typeof o.credentialId === "string" ? o.credentialId : "";
  const key = typeof o.key === "string" ? o.key : "";
  const userHandle = typeof o.userHandle === "string" ? o.userHandle : "";
  if (!DOMAIN.test(rpId) || !B64U.test(credentialId) || credentialId.length > 1400 || !B64U.test(key) || key.length > 512) return null;
  if (userHandle && (!B64U.test(userHandle) || userHandle.length > 100)) return null;
  const alg = typeof o.alg === "number" ? o.alg : -7;
  if (alg !== -7) return null;
  const created = typeof o.created === "number" && Number.isFinite(o.created) && o.created > 0 ? Math.floor(o.created) : 0;
  return {
    rpId, credentialId, userHandle, key, alg, created,
    userName: text(o.userName), displayName: text(o.displayName), rpName: text(o.rpName),
  };
}

/** A login's passkeys: invalid records dropped, duplicates (same RP ID + credential id) kept once, capped. */
export function parsePasskeys(v: unknown): StoredPasskey[] {
  if (!Array.isArray(v)) return [];
  const out: StoredPasskey[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const p = parsePasskey(x);
    if (!p || seen.has(`${p.rpId} ${p.credentialId}`)) continue;
    seen.add(`${p.rpId} ${p.credentialId}`);
    out.push(p);
    if (out.length >= MAX_PASSKEYS) break;
  }
  return out;
}

/** The list after adding `p` (a record with the same RP ID and credential id is replaced). */
export function withPasskey(list: StoredPasskey[] | undefined, p: StoredPasskey): StoredPasskey[] {
  const rest = (list ?? []).filter((x) => !(x.rpId === p.rpId && x.credentialId === p.credentialId));
  return [...rest, p].slice(-MAX_PASSKEYS);
}

/** The list without the passkey `credentialId` of `rpId`. */
export function withoutPasskey(list: StoredPasskey[] | undefined, rpId: string, credentialId: string): StoredPasskey[] {
  return (list ?? []).filter((x) => !(x.rpId === rpId && x.credentialId === credentialId));
}

/** Does this passkey answer a request for `rpId` that allows `allow` (empty = any of the RP's passkeys)? */
export function passkeyUsable(p: Pick<StoredPasskey, "rpId" | "credentialId">, rpId: string, allow: readonly string[]): boolean {
  return p.rpId === rpId && (allow.length === 0 || allow.includes(p.credentialId));
}

/** What the vault UI shows for a passkey (never the key). */
export function passkeyLabel(p: Pick<StoredPasskey, "userName" | "displayName">): string {
  return p.userName || p.displayName || "(no user name)";
}
