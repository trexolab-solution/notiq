import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginMatch } from "./autofill";
import { emptyLogin } from "./loginEntry";

const copySecretTimed = vi.fn();
vi.mock("./secureCopy", () => ({ copySecretTimed: (...a: unknown[]) => copySecretTimed(...a) }));
vi.mock("./loginEntry", async (orig) => ({
  ...(await orig<typeof import("./loginEntry")>()),
  totpCode: async (secret: string) => (secret ? "123456" : null),
}));

const {
  answerList, answerUsernameCopy, copyForExtension, copyTargets, listReply, MAX_LISTED, validCopyWhat,
} = await import("./autofillPopup");

const m = (rel: string, o: Partial<LoginMatch["entry"]> = {}): LoginMatch =>
  ({ path: `/root/${rel}`, rel, entry: { ...emptyLogin("T"), url: "https://example.com", username: "alice", password: "S3cret!", ...o } });

beforeEach(() => copySecretTimed.mockReset());

describe("list reply", () => {
  it("holds titles, usernames and whether a code exists, never a secret", () => {
    const r = listReply([
      m("Logins/Work.nqv", { title: "Work", totp: "JBSWY3DPEHPK3PXP", notes: "secret notes" }),
      m("Logins/Bare.nqv", { title: "", username: "" }),
    ]);
    expect(r).toEqual({ ok: true, accounts: [
      { account: "Logins/Work.nqv", title: "Work", username: "alice", totp: true },
      { account: "Logins/Bare.nqv", title: "https://example.com", username: "", totp: false },
    ] });
    const text = JSON.stringify(r);
    expect(text).not.toContain("S3cret");
    expect(text).not.toContain("JBSWY3");
    expect(text).not.toContain("secret notes");
  });
  it("is capped and skips matches without a vault path", () => {
    const many = Array.from({ length: 70 }, (_, i) => m(`${i}.nqv`));
    expect(listReply(many).accounts).toHaveLength(MAX_LISTED);
    expect(listReply([{ ...m("x.nqv"), rel: undefined }]).accounts).toEqual([]);
  });
});

describe("copy", () => {
  it("validCopyWhat", () => {
    expect(["username", "password", "code"].map(validCopyWhat)).toEqual(["username", "password", "code"]);
    expect(validCopyWhat("notes")).toBeUndefined();
    expect(validCopyWhat(1)).toBeUndefined();
  });
  it("copyTargets returns only the named login", () => {
    const a = m("Logins/a.nqv"), b = m("Logins/b.nqv");
    expect(copyTargets([a, b], "logins/B.nqv")).toEqual([b]);
    expect(copyTargets([a, b], "Logins/c.nqv")).toEqual([]);
    expect(copyTargets([a, b], undefined)).toEqual([]);
    expect(copyTargets([a, b], "../a.nqv")).toEqual([]);
  });
  it("copies in the app and answers without the value", async () => {
    copySecretTimed.mockResolvedValue(30);
    const r = await copyForExtension(m("a.nqv"), "password");
    expect(copySecretTimed).toHaveBeenCalledWith("S3cret!", "Password", { quiet: true });
    expect(r).toEqual({ ok: true, copied: "password", clearAfter: 30 });
    expect(JSON.stringify(r)).not.toContain("S3cret");
  });
  it("copies the current 2FA code", async () => {
    copySecretTimed.mockResolvedValue(0);
    expect(await copyForExtension(m("a.nqv", { totp: "JBSWY3DPEHPK3PXP" }), "code")).toEqual({ ok: true, copied: "code", clearAfter: 0 });
    expect(copySecretTimed).toHaveBeenCalledWith("123456", "2FA code", { quiet: true });
  });
  it("nothing to copy / clipboard failure", async () => {
    expect(await copyForExtension(m("a.nqv"), "code")).toEqual({ error: "no_code" });
    expect(await copyForExtension(m("a.nqv", { password: "" }), "password")).toEqual({ error: "empty" });
    expect(copySecretTimed).not.toHaveBeenCalled();
    copySecretTimed.mockResolvedValue(null);
    expect(await copyForExtension(m("a.nqv"), "username")).toEqual({ error: "failed" });
  });
});

describe("silent popup requests", () => {
  const LOCKED = new Error("locked");
  const deps = (o: { unlocked?: boolean; matches?: LoginMatch[]; scanThrows?: unknown } = {}) => ({
    prepare: vi.fn(async () => undefined),
    unlocked: vi.fn(async () => o.unlocked ?? true),
    scan: vi.fn(async () => { if (o.scanThrows) throw o.scanThrows; return o.matches ?? []; }),
    lockedError: LOCKED,
  });

  it("a locked vault lists nothing (and never scans)", async () => {
    const d = deps({ unlocked: false, matches: [m("a.nqv")] });
    expect(await answerList(d, "example.com")).toEqual({ error: "locked" });
    expect(d.scan).not.toHaveBeenCalled();
  });
  it("lists the host's matches", async () => {
    const d = deps({ matches: [m("a.nqv", { title: "A" })] });
    expect(await answerList(d, "example.com")).toEqual({ ok: true, accounts: [{ account: "a.nqv", title: "A", username: "alice", totp: false }] });
    expect(d.scan).toHaveBeenCalledWith("example.com");
  });
  it("maps a lock during the scan and other failures", async () => {
    expect(await answerList(deps({ scanThrows: LOCKED }), "example.com")).toEqual({ error: "locked" });
    expect(await answerList(deps({ scanThrows: new Error("x") }), "example.com")).toEqual({ error: "failed" });
  });
  it("username copy: only a listed login of this host, only while unlocked", async () => {
    copySecretTimed.mockResolvedValue(30);
    expect(await answerUsernameCopy(deps({ matches: [m("a.nqv")] }), "example.com", "a.nqv")).toEqual({ ok: true, copied: "username", clearAfter: 30 });
    expect(copySecretTimed).toHaveBeenCalledWith("alice", "Username", { quiet: true });
    expect(await answerUsernameCopy(deps({ matches: [m("a.nqv")] }), "example.com", "b.nqv")).toEqual({ error: "stale" });
    expect(await answerUsernameCopy(deps({ unlocked: false, matches: [m("a.nqv")] }), "example.com", "a.nqv")).toEqual({ error: "locked" });
    expect(copySecretTimed).toHaveBeenCalledTimes(1);
  });
});
