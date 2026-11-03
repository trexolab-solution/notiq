import { describe, expect, it, vi } from "vitest";
import { planSave, saveCheckReply, type LoginMatch } from "./autofill";
import { answerSaveCheck, type PopupDeps } from "./autofillPopup";
import { emptyLogin } from "./loginEntry";

vi.mock("./secureCopy", () => ({ copySecretTimed: vi.fn() }));

const m = (rel: string, username: string, password: string): LoginMatch =>
  ({ path: `/root/${rel}`, rel, entry: { ...emptyLogin("T"), url: "https://example.com", username, password } });

const deps = (matches: LoginMatch[], unlocked = true): PopupDeps & { scanned: string[] } => {
  const scanned: string[] = [];
  return {
    scanned,
    prepare: async () => {},
    unlocked: async () => unlocked,
    scan: async (host) => { scanned.push(host); return matches; },
    lockedError: "locked",
  };
};

describe("save_check: should the page offer Save, Update or nothing?", () => {
  it("same site + same username + same password: no offer", async () => {
    const r = await answerSaveCheck(deps([m("a.nqv", "Alice@x.io", "pw-1")]), { host: "example.com", username: "alice@x.io", password: "pw-1" });
    expect(r).toEqual({ ok: true, action: "none", choices: 0 });
  });
  it("same username, other password: update (one login)", async () => {
    const r = await answerSaveCheck(deps([m("a.nqv", "alice", "old")]), { host: "example.com", username: "alice", password: "new" });
    expect(r).toEqual({ ok: true, action: "update", choices: 1 });
  });
  it("several logins with that username: update with a choice", async () => {
    const r = await answerSaveCheck(
      deps([m("a.nqv", "alice", "old-1"), m("b.nqv", "alice", "old-2"), m("c.nqv", "bob", "x")]),
      { host: "example.com", username: "alice", password: "new" },
    );
    expect(r).toEqual({ ok: true, action: "update", choices: 2 });
  });
  it("one of several same-username logins already has this password: no offer", async () => {
    const r = await answerSaveCheck(
      deps([m("a.nqv", "alice", "old"), m("b.nqv", "alice", "new")]),
      { host: "example.com", username: "alice", password: "new" },
    );
    expect(r).toEqual({ ok: true, action: "none", choices: 0 });
  });
  it("a new username: save", async () => {
    const r = await answerSaveCheck(deps([m("a.nqv", "alice", "pw")]), { host: "example.com", username: "carol", password: "pw" });
    expect(r).toEqual({ ok: true, action: "save", choices: 0 });
  });
  it("only the page's site is scanned (the existing site-matching rules)", async () => {
    const d = deps([]);
    await answerSaveCheck(d, { host: "login.example.com", username: "a", password: "b" });
    expect(d.scanned).toEqual(["login.example.com"]);
  });
  it("a locked vault answers locked and compares nothing", async () => {
    const d = deps([m("a.nqv", "alice", "pw")], false);
    expect(await answerSaveCheck(d, { host: "example.com", username: "alice", password: "pw" })).toEqual({ error: "locked" });
    expect(d.scanned).toEqual([]);
  });
  it("the reply never carries vault data", async () => {
    const r = await answerSaveCheck(deps([m("Logins/Secret name.nqv", "alice", "S3cret-old")]), { host: "example.com", username: "alice", password: "new" });
    const text = JSON.stringify(r);
    expect(text).not.toContain("S3cret");
    expect(text).not.toContain("Secret name");
    expect(text).not.toContain("alice");
  });
});

describe("change-password forms (current + new password)", () => {
  it("no username: the login that still holds the current password is updated", () => {
    const a = m("a.nqv", "alice", "old"), b = m("b.nqv", "bob", "other");
    const p = planSave([b, a], { username: "", password: "new", current: "old" });
    expect(p.kind).toBe("update");
    expect(p.target).toBe(a);
    expect(saveCheckReply(p)).toEqual({ ok: true, action: "update", choices: 1 });
  });
  it("no username and the new password is already saved there: no offer", () => {
    expect(planSave([m("a.nqv", "alice", "new")], { username: "", password: "new", current: "new" }).kind).toBe("unchanged");
  });
  it("no username and no login holds the current password: falls back to the empty-username rule", () => {
    expect(planSave([m("a.nqv", "alice", "x")], { username: "", password: "new", current: "old" }).kind).toBe("create");
  });
  it("with a username: the login still holding the current password is pre-selected", () => {
    const a = m("a.nqv", "alice", "older"), b = m("b.nqv", "alice", "old");
    const p = planSave([a, b], { username: "alice", password: "new", current: "old" }, () => 0);
    expect(p.kind).toBe("update");
    expect(p.target).toBe(b);
    expect(p.candidates).toEqual([b, a]);
  });
  it("the current password never picks a login of another username", () => {
    const p = planSave([m("a.nqv", "bob", "old")], { username: "alice", password: "new", current: "old" });
    expect(p.kind).toBe("create");
  });
});

describe("saveCheckReply", () => {
  it("maps each plan to its action", () => {
    expect(saveCheckReply({ kind: "unchanged" })).toEqual({ ok: true, action: "none", choices: 0 });
    expect(saveCheckReply({ kind: "create" })).toEqual({ ok: true, action: "save", choices: 0 });
    const many = Array.from({ length: 30 }, (_, i) => m(`${i}.nqv`, "a", "b"));
    expect(saveCheckReply({ kind: "update", target: many[0], candidates: many }).choices).toBe(20);
    expect(saveCheckReply({ kind: "update", target: many[0] }).choices).toBe(1);
  });
});
