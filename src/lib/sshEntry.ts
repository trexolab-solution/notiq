/** Pure helpers for the SSH / server vault entry (kept free of React so they can be unit-tested). */

export type SshAuth = "key" | "password";

/** Which sign-in method an entry uses; older entries have none stored, so infer it from what's filled in. */
export function inferAuth(f: Record<string, string>): SshAuth {
  if (f.auth === "key" || f.auth === "password") return f.auth;
  if (!f.privateKey?.trim() && f.password?.trim()) return "password";
  return "key";
}

/** Empty = default (22). */
export function portError(port: string): string | null {
  const p = port.trim();
  if (!p) return null;
  return /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535 ? null : "Port must be a number from 1 to 65535";
}

/** `ssh [-p port] [-J jump] user@host`, or null while there is no usable host. */
export function sshCommand(f: Record<string, string>): string | null {
  const host = f.host?.trim();
  const safe = (s: string) => /^[A-Za-z0-9_.@:\-\[\]%]+$/.test(s);
  if (!host || !safe(host)) return null;
  const user = f.username?.trim();
  if (user && !safe(user)) return null;
  const jump = f.jump?.trim();
  if (jump && !safe(jump)) return null;
  const port = f.port?.trim();
  if (port && portError(port)) return null;
  return [
    "ssh",
    port && port !== "22" ? `-p ${port}` : "",
    jump ? `-J ${jump}` : "",
    user ? `${user}@${host}` : host,
  ].filter(Boolean).join(" ");
}

export type KeyState = "empty" | "ok" | "encrypted" | "public" | "incomplete" | "invalid";
export interface KeyInfo { state: KeyState; /** Short human description, e.g. "OpenSSH private key". */ label: string }

/** Cipher name inside a base64 OpenSSH key ("none" = unencrypted); null if it isn't parseable. */
function opensshCipher(body: string): string | null {
  try {
    const bin = atob(body.replace(/\s+/g, ""));
    const magic = "openssh-key-v1\0";
    if (!bin.startsWith(magic)) return null;
    const at = magic.length;
    const len = (bin.charCodeAt(at) << 24) | (bin.charCodeAt(at + 1) << 16) | (bin.charCodeAt(at + 2) << 8) | bin.charCodeAt(at + 3);
    if (len < 0 || len > 64) return null;
    return bin.slice(at + 4, at + 4 + len);
  } catch { return null; }
}

/** Looks at pasted text and says what kind of key it is and whether it needs a passphrase. */
export function analyzeKey(text: string): KeyInfo {
  const t = text.trim();
  if (!t) return { state: "empty", label: "" };

  if (/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-\S+|sk-\S+)\s+[A-Za-z0-9+/=]+/.test(t) || /^-----BEGIN (SSH2 )?PUBLIC KEY-----/.test(t)) {
    return { state: "public", label: "That's a public key — paste the private key instead" };
  }
  if (/^PuTTY-User-Key-File-\d+:/m.test(t)) {
    const enc = /^Encryption:\s*(\S+)/m.exec(t)?.[1];
    return enc && enc !== "none"
      ? { state: "encrypted", label: "PuTTY key (.ppk) · passphrase protected" }
      : { state: "ok", label: "PuTTY key (.ppk) · not encrypted" };
  }

  const m = /^-----BEGIN ([A-Z0-9 ]+)-----/.exec(t);
  if (!m) return { state: "invalid", label: "This doesn't look like a private key" };
  const kind = m[1];
  if (!new RegExp(`-----END ${kind}-----`).test(t)) return { state: "incomplete", label: "Key is cut off — the END line is missing" };
  const body = t.split("\n").filter((l) => l && !l.startsWith("-----") && !/^[A-Za-z-]+:/.test(l) && !l.startsWith(" ")).join("");

  if (kind === "OPENSSH PRIVATE KEY") {
    const cipher = opensshCipher(body);
    if (cipher === null) return { state: "invalid", label: "OpenSSH key looks damaged" };
    return cipher === "none"
      ? { state: "ok", label: "OpenSSH private key · not encrypted" }
      : { state: "encrypted", label: "OpenSSH private key · passphrase protected" };
  }
  if (kind === "ENCRYPTED PRIVATE KEY" || /Proc-Type:\s*4,ENCRYPTED/.test(t)) {
    return { state: "encrypted", label: "PEM private key · passphrase protected" };
  }
  if (/^(RSA |EC |DSA )?PRIVATE KEY$/.test(kind)) {
    return { state: "ok", label: `${kind.replace(" PRIVATE KEY", "") || "PKCS#8"} private key · not encrypted`.replace(/^ /, "") };
  }
  return { state: "invalid", label: `Unrecognised key type (${kind.toLowerCase()})` };
}

/** What to put on the clipboard: trimmed, LF line ends, one trailing newline (ssh refuses keys without it). */
export function normalizeKey(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").trim();
  return t ? `${t}\n` : "";
}
