import { describe, expect, it } from "vitest";
import { MAX_KEY_FILES, parseKeyFiles, rejectReason, roleOf, routeImport, serializeKeyFiles, type KeyFile } from "./sshKeyImport";
import { normalizeKey } from "./sshEntry";
import { ED25519_PRIV, ED25519_PUB, ENC_PRIV, ENC_PUB, RSA_PRIV, RSA_PUB } from "./__fixtures__/sshKeys";

const file = (name: string, value: string) => ({ name, size: value.length, value });
const empty = { privateKey: "", publicKey: "", files: [] as KeyFile[] };
let n = 0;
const id = () => `id${++n}`;

describe("roleOf", () => {
  it("classifies by content, not just the name", () => {
    expect(roleOf("id_ed25519", ED25519_PRIV)).toBe("private");
    expect(roleOf("id_ed25519.pub", ED25519_PUB)).toBe("public");
    expect(roleOf("weird-name", ED25519_PUB)).toBe("public");
    expect(roleOf("config", "Host *\n  User me")).toBe("other");
    expect(roleOf("broken.pub", "not a key")).toBe("other");
  });
});

describe("routeImport", () => {
  it("a single private key file fills the private key field", () => {
    const r = routeImport([file("id_ed25519", ED25519_PRIV)], empty, id);
    expect(r.privateKey).toBe(normalizeKey(ED25519_PRIV));
    expect(r.publicKey).toBe("");
    expect(r.files).toEqual([]);
    expect(r.toPrivate).toBe("id_ed25519");
  });

  it("routes .pub to the public key and keeps every other file in the list", () => {
    const r = routeImport([
      file("id_rsa.pub", RSA_PUB), file("id_ed25519.pub", ED25519_PUB), file("id_ed25519", ED25519_PRIV),
      file("config", "Host *"), file("id_rsa", RSA_PRIV),
    ], empty, id);
    // The private key that has its .pub in the import wins, and gets that .pub.
    expect(r.toPrivate).toBe("id_ed25519");
    expect(r.toPublic).toBe("id_ed25519.pub");
    expect(r.publicKey).toBe(ED25519_PUB.trim());
    expect(r.files.map((f) => f.name)).toEqual(["id_rsa.pub", "config", "id_rsa"]);
  });

  it("pairs a lone .pub with the private key already in the entry", () => {
    const r = routeImport([file("a.pub", RSA_PUB), file("b.pub", ENC_PUB)], { ...empty, privateKey: ENC_PRIV }, id);
    expect(r.toPublic).toBe("b.pub");
    expect(r.files.map((f) => f.name)).toEqual(["a.pub"]);
  });

  it("never loses a replaced key: the old value moves to the list", () => {
    const r = routeImport([file("id_rsa", RSA_PRIV)], { ...empty, privateKey: ED25519_PRIV, publicKey: ED25519_PUB }, id);
    expect(r.privateKey).toBe(normalizeKey(RSA_PRIV));
    expect(r.publicKey).toBe(ED25519_PUB);
    expect(r.displaced).toHaveLength(1);
    expect(r.files[0]).toMatchObject({ name: "Previous private key", value: ED25519_PRIV });
  });

  it("skips files whose text is already in the entry", () => {
    const r = routeImport([file("again", ED25519_PRIV), file("x.pub", ED25519_PUB), file("x2.pub", ED25519_PUB)], { ...empty, privateKey: ED25519_PRIV }, id);
    expect(r.duplicates).toEqual(["again", "x2.pub"]);
    expect(r.toPrivate).toBeNull();
    expect(r.toPublic).toBe("x.pub");
  });

  it("reports files over the list limit instead of dropping them silently", () => {
    const cur = { ...empty, files: Array.from({ length: MAX_KEY_FILES - 1 }, (_, i) => ({ id: `f${i}`, name: `f${i}`, size: 1, value: `v${i}` })) };
    const r = routeImport([file("one", "a"), file("two", "b")], cur, id);
    expect(r.added.map((f) => f.name)).toEqual(["one"]);
    expect(r.overflow).toEqual(["two"]);
  });
});

describe("keyFiles field", () => {
  it("round-trips and tolerates junk", () => {
    const files = [{ id: "a", name: "config", size: 6, value: "Host *" }];
    expect(parseKeyFiles(serializeKeyFiles(files))).toEqual(files);
    expect(serializeKeyFiles([])).toBe("");
    expect(parseKeyFiles("")).toEqual([]);
    expect(parseKeyFiles("{nope")).toEqual([]);
    expect(parseKeyFiles(JSON.stringify([null, { value: "x" }, { name: "n" }]))).toEqual([{ id: "kf-1", name: "Key file 2", size: 1, value: "x" }]);
  });

  it("rejects files that can't be keys", () => {
    expect(rejectReason(100 * 1024, "x")).toMatch(/Too large/);
    expect(rejectReason(3, null)).toMatch(/text/);
    expect(rejectReason(3, "a\0b")).toMatch(/binary/);
    expect(rejectReason(3, "  ")).toMatch(/empty/);
    expect(rejectReason(3, "abc")).toBeNull();
  });
});

describe("other views of an SSH entry", () => {
  it("show each key file as a masked row, never the raw keyFiles JSON", async () => {
    const { previewRows } = await import("./entryPreview");
    const { secretDetails } = await import("./entryDetails");
    const { parseSecret } = await import("./secretEntry");
    const content = JSON.stringify({ v: 1, kind: "ssh", title: "x", fields: { host: "h", publicKey: ED25519_PUB,
      keyFiles: serializeKeyFiles([{ id: "a", name: "config", size: 6, value: "Host *" }]) } });
    const rows = previewRows("ssh", content);
    expect(rows).toContainEqual({ label: "config", value: "Host *", secret: true });
    expect(rows).toContainEqual({ label: "Public key", value: ED25519_PUB, secret: false });
    expect(rows.some((r) => r.value.includes('"id"'))).toBe(false);
    const d = secretDetails(parseSecret("ssh", content));
    expect(d.rows).toContainEqual(expect.objectContaining({ label: "config", secret: true, multiline: true }));
    expect(d.rows.some((r) => r.id === "keyFiles")).toBe(false);
  });
});
