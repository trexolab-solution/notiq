import { describe, expect, it } from "vitest";
import { fingerprintOf, keyFacts, keysMatch } from "./sshKeyInfo";
import { ECDSA_PRIV, ECDSA_PUB, ED25519_PRIV, ED25519_PUB, ENC_PRIV, ENC_PUB, FP, RSA_PRIV, RSA_PUB } from "./__fixtures__/sshKeys";

const fp = async (t: string) => fingerprintOf(keyFacts(t)!.blob!);

describe("keyFacts", () => {
  it("reads public keys: type, size, comment and the ssh-keygen fingerprint", async () => {
    const ed = keyFacts(ED25519_PUB)!;
    expect(ed).toMatchObject({ side: "public", type: "ED25519", bits: 256, comment: "alice@laptop", format: "OpenSSH" });
    expect(await fp(ED25519_PUB)).toBe(FP.ed25519);
    expect(keyFacts(RSA_PUB)).toMatchObject({ type: "RSA", bits: 1024, comment: "rsa@pc" });
    expect(await fp(RSA_PUB)).toBe(FP.rsa);
    expect(keyFacts(ECDSA_PUB)).toMatchObject({ type: "ECDSA", bits: 384, comment: "ec@pc" });
    expect(await fp(ECDSA_PUB)).toBe(FP.ecdsa);
  });

  it("reads unencrypted OpenSSH private keys including the comment", async () => {
    expect(keyFacts(ED25519_PRIV)).toMatchObject({ side: "private", type: "ED25519", bits: 256, encrypted: false, comment: "alice@laptop" });
    expect(keyFacts(RSA_PRIV)).toMatchObject({ type: "RSA", bits: 1024, encrypted: false, comment: "rsa@pc" });
    expect(keyFacts(ECDSA_PRIV)).toMatchObject({ type: "ECDSA", bits: 384, encrypted: false, comment: "ec@pc" });
    expect(await fp(ED25519_PRIV)).toBe(FP.ed25519);
  });

  it("still fingerprints passphrase-protected keys (the comment is encrypted)", async () => {
    expect(keyFacts(ENC_PRIV)).toMatchObject({ encrypted: true, comment: null, type: "ED25519" });
    expect(await fp(ENC_PRIV)).toBe(FP.enc);
  });

  it("tolerates CRLF line ends and RFC 4716 public keys", async () => {
    expect(keyFacts(ED25519_PRIV.replace(/\n/g, "\r\n"))?.comment).toBe("alice@laptop");
    const blob = ED25519_PUB.split(" ")[1];
    const rfc = `---- BEGIN SSH2 PUBLIC KEY ----\nComment: "alice rfc"\n${blob.slice(0, 40)}\n${blob.slice(40)}\n---- END SSH2 PUBLIC KEY ----`;
    expect(keyFacts(rfc)).toMatchObject({ side: "public", format: "RFC 4716", comment: "alice rfc" });
    expect(await fp(rfc)).toBe(FP.ed25519);
  });

  it("reports PEM / PKCS#8 / PuTTY kinds without a fingerprint", () => {
    expect(keyFacts("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----")).toMatchObject({ type: "RSA", format: "PEM", blob: null, encrypted: false });
    expect(keyFacts("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE\n-----END ENCRYPTED PRIVATE KEY-----")).toMatchObject({ format: "PKCS#8", encrypted: true });
    const blob = ED25519_PUB.split(" ")[1];
    expect(keyFacts(`PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: putty-key\nPublic-Lines: 1\n${blob}\nPrivate-Lines: 1\nAAAA\n`))
      .toMatchObject({ format: "PuTTY", type: "ED25519", comment: "putty-key", encrypted: false });
  });

  it("returns null for text that isn't a key and for damaged keys", () => {
    expect(keyFacts("")).toBeNull();
    expect(keyFacts("hello")).toBeNull();
    expect(keyFacts("-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----")).toBeNull();
    expect(keyFacts("ssh-ed25519 AAAA")).toBeNull();
  });
});

describe("keysMatch", () => {
  it("tells a key pair from two unrelated keys, and unknown when it can't", () => {
    expect(keysMatch(keyFacts(ED25519_PRIV), keyFacts(ED25519_PUB))).toBe(true);
    expect(keysMatch(keyFacts(ENC_PRIV), keyFacts(ENC_PUB))).toBe(true);
    expect(keysMatch(keyFacts(ED25519_PRIV), keyFacts(RSA_PUB))).toBe(false);
    expect(keysMatch(keyFacts(ED25519_PRIV), null)).toBeNull();
    expect(keysMatch(keyFacts("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"), keyFacts(RSA_PUB))).toBeNull();
  });
});
