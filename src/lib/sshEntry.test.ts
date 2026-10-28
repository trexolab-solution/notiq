import { describe, expect, it } from "vitest";
import { analyzeKey, inferAuth, normalizeKey, portError, sshCommand } from "./sshEntry";

/** A minimal base64 OpenSSH key blob whose cipher name is `cipher`. */
function openssh(cipher: string): string {
  const u32 = (n: number) => String.fromCharCode((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const bin = "openssh-key-v1\0" + u32(cipher.length) + cipher + u32(4) + "none" + "x".repeat(30);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${btoa(bin)}\n-----END OPENSSH PRIVATE KEY-----`;
}

describe("analyzeKey", () => {
  it("detects empty, public and garbage input", () => {
    expect(analyzeKey("  ").state).toBe("empty");
    expect(analyzeKey("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc user@pc").state).toBe("public");
    expect(analyzeKey("-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----").state).toBe("public");
    expect(analyzeKey("hello world").state).toBe("invalid");
  });

  it("tells encrypted OpenSSH keys from plain ones", () => {
    expect(analyzeKey(openssh("none")).state).toBe("ok");
    expect(analyzeKey(openssh("aes256-ctr")).state).toBe("encrypted");
  });

  it("handles PEM, PKCS#8 and PuTTY keys", () => {
    expect(analyzeKey("-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----").state).toBe("ok");
    expect(analyzeKey("-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,AB\n\nMIIE\n-----END RSA PRIVATE KEY-----").state).toBe("encrypted");
    expect(analyzeKey("-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE\n-----END ENCRYPTED PRIVATE KEY-----").state).toBe("encrypted");
    expect(analyzeKey("-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----").state).toBe("ok");
    expect(analyzeKey("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n").state).toBe("ok");
    expect(analyzeKey("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: aes256-cbc\n").state).toBe("encrypted");
  });

  it("flags a key that is cut off", () => {
    expect(analyzeKey("-----BEGIN OPENSSH PRIVATE KEY-----\nabcd").state).toBe("incomplete");
  });
});

describe("sshCommand / port / auth", () => {
  it("builds the command", () => {
    expect(sshCommand({ host: "example.com", username: "root" })).toBe("ssh root@example.com");
    expect(sshCommand({ host: "1.2.3.4", username: "me", port: "2222", jump: "bastion" })).toBe("ssh -p 2222 -J bastion me@1.2.3.4");
    expect(sshCommand({ host: "h", port: "22" })).toBe("ssh h");
    expect(sshCommand({ host: "" })).toBeNull();
    expect(sshCommand({ host: "a; rm -rf /" })).toBeNull();
    expect(sshCommand({ host: "h", port: "99999" })).toBeNull();
  });

  it("validates ports", () => {
    expect(portError("")).toBeNull();
    expect(portError("22")).toBeNull();
    expect(portError("0")).not.toBeNull();
    expect(portError("65536")).not.toBeNull();
    expect(portError("ssh")).not.toBeNull();
  });

  it("infers the sign-in method for older entries", () => {
    expect(inferAuth({ auth: "password" })).toBe("password");
    expect(inferAuth({ password: "x", privateKey: "" })).toBe("password");
    expect(inferAuth({ password: "x", privateKey: "key" })).toBe("key");
    expect(inferAuth({})).toBe("key");
  });

  it("normalizes a key for copying", () => {
    expect(normalizeKey("  a\r\nb  ")).toBe("a\nb\n");
    expect(normalizeKey("")).toBe("");
  });
});
