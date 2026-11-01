import { describe, expect, it } from "vitest";
import type { LoginMatch } from "../lib/autofill";
import { emptyLogin, parseLogin, serializeLogin } from "../lib/loginEntry";
import { parsePasskeys, passkeyUsable, withoutPasskey, withPasskey, type StoredPasskey } from "../lib/passkeyEntry";
import { defaultPasskeyTarget, passkeyLoginName, passkeyReply, toCreateReq, toGetReq, type PasskeyMatch } from "../lib/passkeys";
import { IDLE, step, type Effect, type Job, type PromptEvent, type PromptState } from "./promptMachine";

const pk = (over: Partial<StoredPasskey> = {}): StoredPasskey => ({
  rpId: "github.com", credentialId: "Y3JlZC0x", userHandle: "dXNlcg", userName: "octo", displayName: "Octo",
  rpName: "GitHub", key: "a2V5", alg: -7, created: 1_700_000_000_000, ...over,
});
const login = (rel: string, username: string): LoginMatch =>
  ({ path: `/root/${rel}`, rel, entry: { ...emptyLogin("GitHub"), url: "https://github.com", username } });

const createJob = (id = "c1", exclude: string[] = []): Job => ({
  kind: "passkeyCreate",
  req: { id, host: "github.com", rpId: "github.com", rpName: "GitHub", userName: "octo", displayName: "Octo", exclude, passkey: pk() },
});
const getJob = (id = "g1", allow: string[] = []): Job => ({ kind: "passkeyGet", req: { id, host: "www.github.com", rpId: "github.com", allow } });
const start = (job: Job, unlocked = true): PromptEvent => ({ type: "start", job, exists: true, unlocked, trusted: true });

function run(s: PromptState, ...events: PromptEvent[]) {
  const effects: Effect[] = [];
  for (const ev of events) { const r = step(s, ev); s = r.state; effects.push(...r.effects); }
  return { state: s, effects };
}
const replies = (fx: Effect[]) => fx.filter((e): e is Extract<Effect, { kind: "reply" }> => e.kind === "reply").map((e) => e.payload);

describe("stored passkeys", () => {
  it("parses valid records and drops bad ones and duplicates", () => {
    const list = parsePasskeys([
      pk(), pk(), pk({ credentialId: "b3RoZXI", rpId: "GitHub.com" }), pk({ key: "not base64!" }), pk({ alg: -257 }),
      { ...pk(), credentialId: 5 }, null, "x", pk({ credentialId: "b3RoZXI", userName: "a\u0000b" }),
    ]);
    expect(list.map((p) => p.credentialId)).toEqual(["Y3JlZC0x", "b3RoZXI"]);
    expect(list[1].userName).toBe("a b");
    expect(parsePasskeys("nope")).toEqual([]);
  });

  it("survives a login edit round trip, and old logins stay unchanged", () => {
    const e = { ...emptyLogin("G"), passkeys: [pk()] };
    expect(parseLogin(serializeLogin(e)).passkeys).toEqual([pk()]);
    // Editing the password (the autofill "update" path) keeps the passkeys.
    const updated = parseLogin(serializeLogin({ ...parseLogin(serializeLogin(e)), password: "new" }));
    expect(updated.passkeys).toEqual([pk()]);
    expect("passkeys" in parseLogin(serializeLogin(emptyLogin("G")))).toBe(false);
  });

  it("adds, replaces and removes by RP ID + credential id", () => {
    const a = pk(), b = pk({ credentialId: "Yg" });
    expect(withPasskey([a], b)).toEqual([a, b]);
    expect(withPasskey([a, b], { ...a, userName: "new" })).toEqual([b, { ...a, userName: "new" }]);
    expect(withoutPasskey([a, b], "github.com", "Yg")).toEqual([a]);
    expect(withoutPasskey([a], "evil.com", a.credentialId)).toEqual([a]);
  });

  it("is usable only for exactly its RP ID and the allowed credentials", () => {
    expect(passkeyUsable(pk(), "github.com", [])).toBe(true);
    expect(passkeyUsable(pk(), "github.com", ["Y3JlZC0x"])).toBe(true);
    expect(passkeyUsable(pk(), "github.com", ["other"])).toBe(false);
    expect(passkeyUsable(pk(), "www.github.com", [])).toBe(false);
    expect(passkeyUsable(pk(), "evil.com", [])).toBe(false);
  });
});

describe("passkey requests from Rust", () => {
  it("accepts a create request only with a record for the same RP ID", () => {
    const base = { id: "c1", host: "github.com", rpId: "github.com", rpName: "GitHub", userName: "octo", displayName: "", exclude: ["eA", 5, "a b"], passkey: pk() };
    expect(toCreateReq(base)).toMatchObject({ rpId: "github.com", exclude: ["eA"] });
    expect(toCreateReq({ ...base, rpId: "evil.com" })).toBeNull();
    expect(toCreateReq({ ...base, passkey: { ...pk(), key: "" } })).toBeNull();
    expect(toCreateReq({ ...base, id: 3 })).toBeNull();
  });

  it("reads a get request", () => {
    expect(toGetReq({ id: "g", host: "github.com", rpId: "github.com", allow: ["YQ", null] })).toEqual(
      { id: "g", host: "github.com", rpId: "github.com", allow: ["YQ"] },
    );
    expect(toGetReq({ id: "g", host: "github.com" })).toBeNull();
  });

  it("picks the login with the same user name, else the only one, else a new login", () => {
    const a = login("Logins/a.nqv", "someone"), b = login("Logins/b.nqv", "Octo");
    expect(defaultPasskeyTarget([a, b], "octo")).toBe(1);
    expect(defaultPasskeyTarget([a], "octo")).toBe(0);
    expect(defaultPasskeyTarget([a, b], "nobody")).toBe(-1);
    expect(defaultPasskeyTarget([], "octo")).toBe(-1);
  });

  it("names a new login after the site", () => {
    expect(passkeyLoginName({ rpName: "Git/Hub", rpId: "github.com" })).toBe("Git Hub");
    expect(passkeyLoginName({ rpName: "", rpId: "github.com" })).toBe("github.com");
  });

  it("the sign-in reply names the entry and credential, never the key", () => {
    const m: PasskeyMatch = { path: "/root/Logins/G.nqv", rel: "Logins\\G.nqv", title: "G", passkey: pk() };
    expect(passkeyReply(m)).toEqual({ ok: true, account: "Logins/G.nqv", credentialId: "Y3JlZC0x" });
  });
});

describe("prompt state machine: passkeys", () => {
  it("create: never silent, picks a login, saves on Allow", () => {
    let r = run(IDLE, start(createJob()));
    expect(r.state).toMatchObject({ stage: "checking", silent: false });
    expect(r.effects).toEqual([{ kind: "scanPasskeyTargets", host: "github.com", rpId: "github.com", exclude: [] }]);
    const a = login("Logins/a.nqv", "octo");
    r = run(r.state, { type: "passkeyTargetsScanned", logins: [a], excluded: false });
    expect(r.state).toMatchObject({ stage: "passkeyCreate", pick: 0 });
    expect(r.effects.map((e) => e.kind)).toEqual(["show"]);
    r = run(r.state, { type: "pick", index: -5 });
    expect(r.state).toMatchObject({ pick: -1 });
    r = run(r.state, { type: "allow" });
    expect(r.effects).toEqual([{ kind: "savePasskey", id: "c1", target: null, req: (createJob() as Extract<Job, { kind: "passkeyCreate" }>).req }]);
    r = run(r.state, { type: "answered" });
    expect(r.state).toEqual(IDLE);
  });

  it("create: an excluded credential saves nothing and answers `excluded` only after the user saw it", () => {
    let r = run(IDLE, start(createJob("c2", ["Y3JlZC0x"])), { type: "passkeyTargetsScanned", logins: [], excluded: true });
    expect(r.state).toMatchObject({ stage: "passkeyCreate", excluded: true });
    expect(replies(r.effects)).toEqual([]);
    r = run(r.state, { type: "allow" });
    expect(replies(r.effects)).toEqual([{ error: "excluded" }]);
    expect(r.effects.some((e) => e.kind === "savePasskey")).toBe(false);
  });

  it("create from a locked vault: unlocking still leads to the Save question", () => {
    let r = run(IDLE, start(createJob(), false));
    expect(r.state.stage).toBe("locked");
    r = run(r.state, { type: "unlocked" }, { type: "passkeyTargetsScanned", logins: [], excluded: false });
    expect(r.state).toMatchObject({ stage: "passkeyCreate", pick: -1, busy: false });
    expect(r.effects.some((e) => e.kind === "savePasskey")).toBe(false);
  });

  it("get: no usable passkey answers no_passkey without showing anything", () => {
    const r = run(IDLE, start(getJob()), { type: "passkeysScanned", passkeys: [] });
    expect(replies(r.effects)).toEqual([{ error: "no_passkey" }]);
    expect(r.effects.some((e) => e.kind === "show")).toBe(false);
    expect(r.state).toEqual(IDLE);
  });

  it("get: always asks, even right after an unlock, then releases the picked passkey", () => {
    let r = run(IDLE, start(getJob("g1", ["Y3JlZC0x"]), false), { type: "unlocked" });
    expect(r.effects).toEqual([{ kind: "show" }, { kind: "scanPasskeys", rpId: "github.com", allow: ["Y3JlZC0x"] }]);
    const one: PasskeyMatch = { path: "/r/a.nqv", rel: "a.nqv", title: "A", passkey: pk() };
    const two: PasskeyMatch = { path: "/r/b.nqv", rel: "b.nqv", title: "B", passkey: pk({ credentialId: "Yg" }) };
    r = run(r.state, { type: "passkeysScanned", passkeys: [one, two] });
    expect(r.state).toMatchObject({ stage: "passkeyGet", pick: 0 });
    expect(replies(r.effects)).toEqual([]);
    r = run(r.state, { type: "pick", index: 9 }, { type: "allow" });
    expect(r.effects).toEqual([{ kind: "releasePasskey", id: "g1", match: two }]);
  });

  it("deny and lock answer the request", () => {
    const shown = run(IDLE, start(getJob()), { type: "passkeysScanned", passkeys: [{ path: "/a", rel: "a", title: "A", passkey: pk() }] }).state;
    expect(replies(run(shown, { type: "deny" }).effects)).toEqual([{ error: "denied" }]);
    expect(replies(run(shown, { type: "vaultLocked" }).effects)).toEqual([{ error: "locked" }]);
    const create = run(IDLE, start(createJob()), { type: "passkeyTargetsScanned", logins: [], excluded: false }).state;
    expect(replies(run(create, { type: "deny" }).effects)).toEqual([{ error: "denied" }]);
  });
});
