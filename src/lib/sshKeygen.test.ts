import { describe, it, expect } from "vitest";
import { applyGeneratedKey, defaultComment, validateKeygen } from "./sshKeygen";
import { parseKeyFiles } from "./sshKeyImport";

const gen = { private_key: "NEWPRIV\n", public_key: "ssh-ed25519 AAAA me@h", fingerprint: "SHA256:x" };

describe("applyGeneratedKey", () => {
  it("fills the key fields and selects key sign-in", () => {
    const out = applyGeneratedKey({}, gen, "pp");
    expect(out).toMatchObject({ privateKey: "NEWPRIV\n", publicKey: gen.public_key, passphrase: "pp", auth: "key" });
    expect(parseKeyFiles(out.keyFiles)).toEqual([]);
  });
  it("keeps a replaced private and public key in the other-files list", () => {
    const out = applyGeneratedKey({ privateKey: "OLDPRIV", publicKey: "ssh-rsa OLD" }, gen, "", 1);
    expect(parseKeyFiles(out.keyFiles).map((k) => [k.name, k.value])).toEqual([
      ["Previous private key", "OLDPRIV"], ["Previous public key", "ssh-rsa OLD"],
    ]);
  });
  it("does not keep empty old keys", () => {
    expect(parseKeyFiles(applyGeneratedKey({ privateKey: "  ", publicKey: "" }, gen, "").keyFiles)).toEqual([]);
  });
});

describe("validateKeygen", () => {
  it("requires a comment", () => {
    expect(validateKeygen({ comment: "  ", pass: "", confirm: "" }).comment).toBeTruthy();
    expect(validateKeygen({ comment: "me@h", pass: "", confirm: "" })).toEqual({});
  });
  it("needs the passphrase typed twice, but only when one is set", () => {
    expect(validateKeygen({ comment: "c", pass: "a", confirm: "b" }).confirm).toBeTruthy();
    expect(validateKeygen({ comment: "c", pass: "a", confirm: "a" })).toEqual({});
    expect(validateKeygen({ comment: "c", pass: "", confirm: "x" })).toEqual({});
  });
});

describe("defaultComment", () => {
  it("is user@host, host, or empty", () => {
    expect(defaultComment({ host: "h.io", username: "root" })).toBe("root@h.io");
    expect(defaultComment({ host: "h.io" })).toBe("h.io");
    expect(defaultComment({})).toBe("");
  });
});
