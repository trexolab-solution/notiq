/**
 * Reads what can be learned from an SSH key without decrypting it: algorithm, size, the SHA256
 * fingerprint `ssh-keygen -lf` prints, the comment and whether a private key is passphrase protected.
 *
 * Works on OpenSSH public keys (`ssh-ed25519 AAAA… comment`), RFC 4716 public keys, OpenSSH private
 * keys (the public half is stored unencrypted in their header, so encrypted keys still give a
 * fingerprint) and PuTTY .ppk files. PEM / PKCS#8 private keys only report their kind. Pure and
 * React-free so it can be unit-tested.
 */

export interface KeyFacts {
  /** "public" or "private". */
  side: "public" | "private";
  /** Wire algorithm, e.g. "ssh-ed25519"; null when unknown (PEM keys). */
  algorithm: string | null;
  /** Short display type: "ED25519", "RSA", "ECDSA", "DSA", "ED25519-SK" … */
  type: string | null;
  bits: number | null;
  /** The public key blob (what the fingerprint is computed from); null when not derivable. */
  blob: Uint8Array | null;
  comment: string | null;
  /** Private keys only: passphrase protected? null for public keys or when unknown. */
  encrypted: boolean | null;
  /** Container format, for display. */
  format: "OpenSSH" | "RFC 4716" | "PuTTY" | "PEM" | "PKCS#8";
}

function b64ToBytes(b64: string): Uint8Array | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

/** Sequential reader for the SSH wire format (uint32 lengths, big-endian). Throws on overrun. */
class Reader {
  private at = 0;
  constructor(private readonly b: Uint8Array) {}
  get done() { return this.at >= this.b.length; }
  u32(): number {
    if (this.at + 4 > this.b.length) throw new Error("short");
    const b = this.b, i = this.at;
    this.at += 4;
    return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  }
  bytes(): Uint8Array {
    const n = this.u32();
    if (n > this.b.length - this.at) throw new Error("short");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  str(): string { return new TextDecoder().decode(this.bytes()); }
  raw(n: number): Uint8Array {
    if (n > this.b.length - this.at) throw new Error("short");
    const out = this.b.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
}

/** Bit length of an SSH mpint (big-endian, possibly with a leading 0x00 sign byte). */
function mpintBits(m: Uint8Array): number {
  let i = 0;
  while (i < m.length && m[i] === 0) i++;
  if (i === m.length) return 0;
  return (m.length - i - 1) * 8 + (32 - Math.clz32(m[i]));
}

const CURVE_BITS: Record<string, number> = { nistp256: 256, nistp384: 384, nistp521: 521 };

/** Algorithm, display type and size from a public key blob; null when the blob is unreadable. */
export function blobFacts(blob: Uint8Array): { algorithm: string; type: string; bits: number | null } | null {
  try {
    const r = new Reader(blob);
    const alg = r.str();
    if (alg === "ssh-ed25519") return { algorithm: alg, type: "ED25519", bits: 256 };
    if (alg === "sk-ssh-ed25519@openssh.com") return { algorithm: alg, type: "ED25519-SK", bits: 256 };
    if (alg === "ssh-rsa") { r.bytes(); return { algorithm: alg, type: "RSA", bits: mpintBits(r.bytes()) }; }
    if (alg === "ssh-dss") return { algorithm: alg, type: "DSA", bits: mpintBits(r.bytes()) };
    const ec = /^(sk-)?ecdsa-sha2-(nistp\d+)/.exec(alg);
    if (ec) return { algorithm: alg, type: ec[1] ? "ECDSA-SK" : "ECDSA", bits: CURVE_BITS[ec[2]] ?? null };
    if (!/^[\w@.-]+$/.test(alg)) return null;
    return { algorithm: alg, type: alg.replace(/^ssh-/, "").toUpperCase(), bits: null };
  } catch { return null; }
}

/** `SHA256:…` exactly as `ssh-keygen -l -E sha256` prints it (unpadded base64). */
export async function fingerprintOf(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", blob as BufferSource));
  return `SHA256:${bytesToB64(digest).replace(/=+$/, "")}`;
}

export const sameBlob = (a: Uint8Array | null, b: Uint8Array | null) =>
  !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

const PUB_LINE = /^((?:sk-)?(?:ssh|ecdsa)-[\w@.-]+)\s+([A-Za-z0-9+/]+={0,3})(?:\s+(.*))?$/;

function publicFacts(text: string): KeyFacts | null {
  const t = text.trim();
  const line = PUB_LINE.exec(t.split("\n")[0].trim());
  if (line) {
    const blob = b64ToBytes(line[2]);
    const f = blob && blobFacts(blob);
    if (!blob || !f) return null;
    return { side: "public", ...f, blob, comment: line[3]?.trim() || null, encrypted: null, format: "OpenSSH" };
  }
  // RFC 4716: "---- BEGIN SSH2 PUBLIC KEY ----", optional headers (Comment: "…"), base64 body.
  const m = /^-{4,5} ?BEGIN SSH2 PUBLIC KEY ?-{4,5}\n([\s\S]*?)\n-{4,5} ?END SSH2 PUBLIC KEY ?-{4,5}/.exec(t.replace(/\r\n?/g, "\n"));
  if (!m) return null;
  let comment: string | null = null;
  const body: string[] = [];
  let cont = false;
  for (const l of m[1].split("\n")) {
    if (cont) { cont = l.endsWith("\\"); continue; }
    const h = /^([\w-]+):\s*(.*)$/.exec(l);
    if (h) {
      if (h[1].toLowerCase() === "comment") comment = h[2].replace(/^"(.*)"$/, "$1");
      cont = l.endsWith("\\");
      continue;
    }
    body.push(l.trim());
  }
  const blob = b64ToBytes(body.join(""));
  const f = blob && blobFacts(blob);
  if (!blob || !f) return null;
  return { side: "public", ...f, blob, comment, encrypted: null, format: "RFC 4716" };
}

/** Comment from the (unencrypted) private section of an OpenSSH key, by key type. */
function opensshComment(priv: Uint8Array, alg: string): string | null {
  try {
    const r = new Reader(priv);
    const c1 = r.u32(), c2 = r.u32();
    if (c1 !== c2) return null;
    if (r.str() !== alg) return null;
    const skip = (n: number) => { for (let i = 0; i < n; i++) r.bytes(); };
    if (alg === "ssh-ed25519") skip(2);
    else if (alg === "ssh-rsa") skip(6);
    else if (alg === "ssh-dss") skip(5);
    else if (/^ecdsa-sha2-/.test(alg)) skip(3);
    else if (alg === "sk-ssh-ed25519@openssh.com") { skip(2); r.raw(1); skip(2); }
    else if (/^sk-ecdsa-sha2-/.test(alg)) { skip(3); r.raw(1); skip(2); }
    else return null;
    return r.str() || null;
  } catch { return null; }
}

function opensshPrivateFacts(body: string): KeyFacts | null {
  const bin = b64ToBytes(body);
  if (!bin) return null;
  const magic = "openssh-key-v1\0";
  if (bin.length < magic.length || new TextDecoder().decode(bin.subarray(0, magic.length)) !== magic) return null;
  try {
    const r = new Reader(bin.subarray(magic.length));
    const cipher = r.str();
    r.str(); r.bytes(); // kdf name, kdf options
    const n = r.u32();
    if (n < 1 || n > 16) return null;
    const blob = r.bytes();
    for (let i = 1; i < n; i++) r.bytes();
    const f = blobFacts(blob);
    if (!f) return null;
    const encrypted = cipher !== "none";
    const comment = encrypted ? null : opensshComment(r.bytes(), f.algorithm);
    return { side: "private", ...f, blob, comment, encrypted, format: "OpenSSH" };
  } catch { return null; }
}

function puttyFacts(t: string): KeyFacts | null {
  const head = /^PuTTY-User-Key-File-\d+:\s*(\S+)/m.exec(t);
  if (!head) return null;
  const enc = /^Encryption:\s*(\S+)/m.exec(t)?.[1];
  const comment = /^Comment:\s*(.*)$/m.exec(t)?.[1].trim() || null;
  const lines = t.split("\n");
  const at = lines.findIndex((l) => /^Public-Lines:\s*\d+/.test(l));
  let blob: Uint8Array | null = null;
  if (at >= 0) {
    const n = Number(/\d+/.exec(lines[at])![0]);
    blob = b64ToBytes(lines.slice(at + 1, at + 1 + n).join(""));
  }
  const f = blob ? blobFacts(blob) : null;
  return {
    side: "private",
    algorithm: f?.algorithm ?? head[1], type: f?.type ?? head[1].replace(/^ssh-/, "").toUpperCase(), bits: f?.bits ?? null,
    blob: f ? blob : null, comment, encrypted: enc ? enc !== "none" : null, format: "PuTTY",
  };
}

/** Everything derivable from a pasted / imported key, or null when it isn't a recognisable key. */
export function keyFacts(text: string): KeyFacts | null {
  const t = text.replace(/\r\n?/g, "\n").trim();
  if (!t) return null;
  const pub = publicFacts(t);
  if (pub) return pub;
  if (/^PuTTY-User-Key-File-\d+:/m.test(t)) return puttyFacts(t);

  const m = /^-----BEGIN ([A-Z0-9 ]+)-----\n([\s\S]*?)\n?-----END \1-----/.exec(t);
  if (!m) return null;
  const kind = m[1];
  const body = m[2].split("\n").filter((l) => l && !/^[A-Za-z-]+:/.test(l) && !l.startsWith(" ")).join("");
  if (kind === "OPENSSH PRIVATE KEY") return opensshPrivateFacts(body);
  const pemType = /^(RSA|EC|DSA) PRIVATE KEY$/.exec(kind)?.[1];
  if (pemType || kind === "PRIVATE KEY" || kind === "ENCRYPTED PRIVATE KEY") {
    return {
      side: "private", algorithm: null, type: pemType === "EC" ? "ECDSA" : pemType ?? null, bits: null, blob: null,
      comment: null, encrypted: kind === "ENCRYPTED PRIVATE KEY" || /Proc-Type:\s*4,ENCRYPTED/.test(t),
      format: pemType ? "PEM" : "PKCS#8",
    };
  }
  return null;
}

/**
 * Do these two keys belong to one pair? true / false when both public halves are known, null when it
 * can't be told (one side empty, or a PEM key whose public half isn't parsed).
 */
export function keysMatch(a: KeyFacts | null, b: KeyFacts | null): boolean | null {
  if (!a?.blob || !b?.blob) return null;
  return sameBlob(a.blob, b.blob);
}
