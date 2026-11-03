import { ERR_LOCKED, vaultReadFile, vaultStatus, type VaultFile, type VaultStatus } from "./vault";
import { LOGIN_EXT, loginUrls, parseLogin, type LoginEntry } from "./loginEntry";
import { isChecked, parseSecret, SECRET_KINDS, type SecretEntry } from "./secretEntry";
import { formatCardNumber } from "./cardEntry";
import type { CustomField } from "./customFields";
import { parseKeyFiles } from "./sshKeyImport";

/**
 * Read-only "details" of one vault entry for the autofill window's details view (desktop UI only:
 * nothing here is ever sent to the browser extension). Built from a fresh read of the entry, made
 * only when the user opens the view and only while the vault is unlocked.
 */

/** One labelled value. `secret` values stay masked until revealed. */
export interface DetailRow {
  id: string;
  label: string;
  value: string;
  secret: boolean;
  multiline?: boolean;
  /** The value as shown (e.g. a card number in groups of four); copying always uses `value`. */
  display?: string;
}

export interface EntryDetails {
  kind: string;
  title: string;
  /** Websites (logins only), main one first. */
  sites: string[];
  rows: DetailRow[];
  /** Base32 2-step secret (logins only); the view shows the live code, never the secret. */
  totp: string;
  notes: string;
}

function customRows(custom: CustomField[] | undefined): DetailRow[] {
  return (custom ?? [])
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.label.trim() || f.value)
    .map(({ f, i }) => ({ id: `custom-${i}`, label: f.label.trim() || `Field ${i + 1}`, value: f.value, secret: f.secret }));
}

/** An SSH entry's extra key files, one masked multiline row each. */
const keyFileRows = (e: SecretEntry): DetailRow[] => e.kind !== "ssh" ? [] :
  parseKeyFiles(e.fields.keyFiles).map((k) => ({ id: `keyfile-${k.id}`, label: k.name, value: k.value, secret: true, multiline: true }));

export function loginDetails(e: LoginEntry): EntryDetails {
  const sites = loginUrls(e);
  return {
    kind: LOGIN_EXT,
    title: e.title.trim() || sites[0] || "Login",
    sites,
    rows: [
      { id: "username", label: "Username", value: e.username, secret: false },
      { id: "password", label: "Password", value: e.password, secret: true },
      ...customRows(e.custom),
    ],
    totp: e.totp.trim(),
    notes: e.notes,
  };
}

/** Cards, identities and the other structured kinds: their schema's fields (non-empty ones), then custom fields. */
export function secretDetails(e: SecretEntry): EntryDetails {
  const def = SECRET_KINDS[e.kind];
  const rows: DetailRow[] = [];
  for (const f of def?.fields ?? []) {
    if (f.key === "notes" || f.internal) continue;
    const raw = e.fields[f.key] ?? "";
    if (f.type === "checkbox") { if (isChecked(raw)) rows.push({ id: f.key, label: f.label, value: "Yes", secret: false }); continue; }
    if (!raw) continue;
    rows.push({
      id: f.key, label: f.label, value: raw,
      secret: f.type === "secret" || f.type === "multiline-secret",
      ...(f.type === "multiline" || f.type === "multiline-secret" ? { multiline: true } : {}),
      ...(f.format === "card" ? { display: formatCardNumber(raw) } : {}),
    });
  }
  const fallbackTitle = e.fields.cardholder?.trim() || e.fields.name?.trim() || def?.label || "Entry";
  return {
    kind: e.kind,
    title: e.title.trim() || fallbackTitle,
    sites: [],
    rows: [...rows, ...keyFileRows(e), ...customRows(e.custom)],
    totp: "",
    notes: e.fields.notes ?? "",
  };
}

/** Details of a decrypted vault file, or null for a kind the view doesn't show (notes, unknown kinds). */
export function detailsFromFile(f: VaultFile): EntryDetails | null {
  if (f.ext === LOGIN_EXT) return loginDetails(parseLogin(f.content));
  if (SECRET_KINDS[f.ext]) return secretDetails(parseSecret(f.ext, f.content));
  return null;
}

export interface DetailsDeps {
  status: () => Promise<VaultStatus>;
  read: (path: string) => Promise<VaultFile>;
}
const defaultDeps: DetailsDeps = { status: vaultStatus, read: vaultReadFile };

/**
 * Reads one entry for the details view. Rejects with `ERR_LOCKED` when the vault is locked (checked
 * first, so a locked vault never reaches the read), and with "unsupported" for a kind it can't show.
 */
export async function loadEntryDetails(path: string, deps: DetailsDeps = defaultDeps): Promise<EntryDetails> {
  if (!(await deps.status()).unlocked) throw ERR_LOCKED;
  const d = detailsFromFile(await deps.read(path));
  if (!d) throw new Error("unsupported");
  return d;
}
