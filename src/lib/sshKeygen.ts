import { byteLength, MAX_KEY_FILES, parseKeyFiles, serializeKeyFiles } from "./sshKeyImport";

/** What the backend's `ssh_generate_key` returns. */
export interface GeneratedKey {
  private_key: string;
  public_key: string;
  fingerprint: string;
}

export type KeyKind = "ed25519" | "rsa4096";

/** Default key comment: `user@host`, else the host, else nothing. */
export function defaultComment(f: Record<string, string>): string {
  const host = f.host?.trim();
  if (!host) return "";
  const user = f.username?.trim();
  return user ? `${user}@${host}` : host;
}

export interface KeygenErrors { comment?: string; confirm?: string }

/** Form rules for the generate dialog: a comment is required, and a passphrase must be typed twice. */
export function validateKeygen(v: { comment: string; pass: string; confirm: string }): KeygenErrors {
  const errors: KeygenErrors = {};
  if (!v.comment.trim()) errors.comment = "Enter a comment, for example you@laptop";
  if (v.pass && v.confirm !== v.pass) errors.confirm = "The passphrases don't match";
  return errors;
}

/**
 * The entry fields to write after generating a key. A private or public key that was already in the
 * entry is not thrown away: it goes into the "other key files" list (as long as there is room).
 * The passphrase is stored with the key so the terminal can answer ssh's passphrase prompt.
 */
export function applyGeneratedKey(cur: Record<string, string>, gen: GeneratedKey, passphrase: string, stamp = Date.now()): Record<string, string> {
  const files = parseKeyFiles(cur.keyFiles);
  const keep = (value: string | undefined, name: string) => {
    const v = value?.trim();
    if (!v || files.length >= MAX_KEY_FILES) return;
    files.push({ id: `kf-${stamp.toString(36)}-${files.length}`, name, size: byteLength(value ?? ""), value: value ?? "" });
  };
  keep(cur.privateKey, "Previous private key");
  keep(cur.publicKey, "Previous public key");
  return {
    privateKey: gen.private_key,
    publicKey: gen.public_key,
    passphrase,
    auth: "key",
    keyFiles: serializeKeyFiles(files),
  };
}
