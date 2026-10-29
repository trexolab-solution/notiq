import { afterEach, describe, expect, it } from "vitest";
import { clearTrust, isTrusted, trustHost, type LoginMatch } from "../lib/autofill";
import { emptyLogin } from "../lib/loginEntry";
import {
  currentId, dropFromQueue, enqueue, IDLE, MAX_QUEUE, step, type Effect, type Job, type PromptEvent, type PromptState,
} from "./promptMachine";

const m = (rel: string, username: string, password = `pw-${username}`): LoginMatch =>
  ({ path: `/root/${rel}`, rel, entry: { ...emptyLogin("T"), url: "https://example.com", username, password } });

const fill = (id = "f1", account?: string): Job => ({ kind: "fill", req: { id, host: "example.com", ...(account ? { account } : {}) } });
const save = (id = "s1", username = "me", password = "new"): Job =>
  ({ kind: "save", req: { id, host: "example.com", url: "https://example.com/login", username, password, title: "Example" } });

const start = (job: Job, o: Partial<{ exists: boolean; unlocked: boolean; trusted: boolean }> = {}): PromptEvent =>
  ({ type: "start", job, exists: o.exists ?? true, unlocked: o.unlocked ?? true, trusted: o.trusted ?? false });

/** Runs events from `s`, collecting every effect. */
function run(s: PromptState, ...events: PromptEvent[]) {
  const effects: Effect[] = [];
  for (const ev of events) { const r = step(s, ev); s = r.state; effects.push(...r.effects); }
  return { state: s, effects };
}
const kinds = (fx: Effect[]) => fx.map((e) => e.kind);
const replies = (fx: Effect[]) => fx.filter((e): e is Extract<Effect, { kind: "reply" }> => e.kind === "reply").map((e) => e.payload);

describe("prompt state machine: fill", () => {
  it("locked → unlock → request → allow → done (one release, then finish)", () => {
    let r = run(IDLE, start(fill(), { unlocked: false }));
    expect(r.state.stage).toBe("locked");
    expect(kinds(r.effects)).toEqual(["show"]);

    r = run(r.state, { type: "unlockStarted" }, { type: "unlockFailed", error: "Wrong password" });
    expect(r.state).toMatchObject({ stage: "locked", busy: false, error: "Wrong password" });

    r = run(r.state, { type: "unlocked" });
    expect(r.state).toMatchObject({ stage: "checking", silent: false });
    expect(r.effects).toEqual([{ kind: "scan", host: "example.com" }]);

    const a = m("Logins/a.nqv", "a"), b = m("Logins/b.nqv", "b");
    r = run(r.state, { type: "scanned", matches: [a, b], lookalike: null });
    expect(r.state).toMatchObject({ stage: "request", pick: 0, trust: false });
    expect(kinds(r.effects)).toEqual(["show"]);

    r = run(r.state, { type: "pick", index: 1 }, { type: "trust", on: true }, { type: "allow" });
    expect(r.effects).toEqual([{ kind: "release", id: "f1", match: b, trustHost: "example.com" }]);
    expect(r.state).toMatchObject({ stage: "request", busy: true });
    // A second click while busy does nothing.
    expect(step(r.state, { type: "allow" }).effects).toEqual([]);

    r = run(r.state, { type: "answered" });
    expect(r.state).toBe(IDLE);
    expect(kinds(r.effects)).toEqual(["finish"]);
  });

  it("preselects the requested account and clamps picks", () => {
    const list = [m("Logins/a.nqv", "a"), m("Logins/b.nqv", "b")];
    const r = run(IDLE, start(fill("f1", "logins/B.nqv")), { type: "scanned", matches: list, lookalike: null });
    expect(r.state).toMatchObject({ stage: "request", pick: 1 });
    expect(run(r.state, { type: "pick", index: 9 }).state).toMatchObject({ pick: 1 });
    expect(run(r.state, { type: "pick", index: -3 }).state).toMatchObject({ pick: 0 });
  });

  it("deny answers denied; Esc while locked answers locked", () => {
    const req = run(IDLE, start(fill()), { type: "scanned", matches: [m("Logins/a.nqv", "a")], lookalike: null }).state;
    let r = run(req, { type: "deny" });
    expect(replies(r.effects)).toEqual([{ error: "denied" }]);
    expect(kinds(r.effects)).toEqual(["reply", "finish"]);
    expect(r.state).toBe(IDLE);

    r = run(IDLE, start(fill(), { unlocked: false }), { type: "deny" });
    expect(replies(r.effects)).toEqual([{ error: "locked" }]);
    expect(r.state).toBe(IDLE);
  });

  it("no match is answered without ever showing the window", () => {
    const r = run(IDLE, start(fill()), { type: "scanned", matches: [], lookalike: null });
    expect(kinds(r.effects)).toEqual(["scan", "reply", "finish"]);
    expect(replies(r.effects)).toEqual([{ error: "no_match" }]);
  });

  it("a look-alike page gets no_match and a warning the user dismisses", () => {
    let r = run(IDLE, start(fill()), { type: "scanned", matches: [], lookalike: { saved: "example.org", reason: "tld" } });
    expect(replies(r.effects)).toEqual([{ error: "no_match" }]);
    expect(kinds(r.effects)).toEqual(["scan", "reply", "show"]);
    expect(r.state.stage).toBe("warning");
    expect(currentId(r.state)).toBeNull();
    r = run(r.state, { type: "deny" });
    expect(kinds(r.effects)).toEqual(["finish"]);
  });

  it("a trusted site fills silently (no show)", () => {
    const a = m("Logins/a.nqv", "a");
    const r = run(IDLE, start(fill(), { trusted: true }), { type: "scanned", matches: [a], lookalike: null }, { type: "answered" });
    expect(kinds(r.effects)).toEqual(["scan", "release", "finish"]);
    expect(r.effects[1]).toEqual({ kind: "release", id: "f1", match: a, trustHost: null });
  });

  it("a trusted site with several logins and no account gets a choose list, silently", () => {
    const r = run(IDLE, start(fill(), { trusted: true }),
      { type: "scanned", matches: [m("Logins/a.nqv", "a"), m("Logins/b.nqv", "b")], lookalike: null });
    expect(kinds(r.effects)).toEqual(["scan", "reply", "finish"]);
    expect(replies(r.effects)[0]).toEqual({ choose: [
      { account: "Logins/a.nqv", title: "T", username: "a" },
      { account: "Logins/b.nqv", title: "T", username: "b" },
    ] });
  });

  it("an unlock never fills silently, even for a trusted host: with several logins it still asks", () => {
    const r = run(IDLE, start(fill(), { unlocked: false, trusted: true }), { type: "unlocked" },
      { type: "scanned", matches: [m("Logins/a.nqv", "a"), m("Logins/b.nqv", "b")], lookalike: null });
    expect(r.state.stage).toBe("request");
  });

  it("unlocking in the prompt counts as consent: one match is filled without a second Allow", () => {
    const a = m("Logins/a.nqv", "a");
    const r = run(IDLE, start(fill(), { unlocked: false }), { type: "unlocked" },
      { type: "scanned", matches: [a], lookalike: null });
    expect(r.effects.slice(-1)).toEqual([{ kind: "release", id: "f1", match: a, trustHost: null }]);
  });

  it("an already unlocked vault still asks for Allow with a single match", () => {
    const r = run(IDLE, start(fill()), { type: "scanned", matches: [m("Logins/a.nqv", "a")], lookalike: null });
    expect(r.state.stage).toBe("request");
  });

  it("unlocking for a save still asks before writing", () => {
    const r = run(IDLE, start(save(), { unlocked: false }), { type: "unlocked" },
      { type: "scanned", matches: [], lookalike: null });
    expect(r.state.stage).toBe("save");
  });

  it("locking the vault cancels an open request with locked; the locked screen stays", () => {
    const req = run(IDLE, start(fill()), { type: "scanned", matches: [m("Logins/a.nqv", "a")], lookalike: null }).state;
    const r = run(req, { type: "vaultLocked" });
    expect(replies(r.effects)).toEqual([{ error: "locked" }]);
    expect(r.state).toBe(IDLE);
    const locked = run(IDLE, start(fill(), { unlocked: false })).state;
    expect(step(locked, { type: "vaultLocked" })).toEqual({ state: locked, effects: [] });
  });

  it("a timeout drops only the matching request, without a reply", () => {
    const req = run(IDLE, start(fill("f1")), { type: "scanned", matches: [m("Logins/a.nqv", "a")], lookalike: null }).state;
    expect(step(req, { type: "cancel", id: "other" }).state).toBe(req);
    const r = run(req, { type: "cancel", id: "f1" });
    expect(r.effects).toEqual([{ kind: "finish" }]);
    expect(r.state).toBe(IDLE);
  });

  it("no vault at all: answered locked, nothing shown", () => {
    const r = run(IDLE, start(fill(), { exists: false, unlocked: false }));
    expect(kinds(r.effects)).toEqual(["reply", "finish"]);
    expect(replies(r.effects)).toEqual([{ error: "locked" }]);
  });

  it("a scan failure answers failed", () => {
    const r = run(IDLE, start(fill()), { type: "failed" });
    expect(replies(r.effects)).toEqual([{ error: "failed" }]);
    expect(r.state).toBe(IDLE);
  });

  it("a second start while busy is refused (the window queues instead)", () => {
    const busy = run(IDLE, start(fill("f1"), { unlocked: false })).state;
    const r = step(busy, start(fill("f2")));
    expect(r.state).toBe(busy);
    expect(r.effects).toEqual([{ kind: "reply", id: "f2", payload: { error: "denied" } }]);
  });
});

describe("prompt state machine: save", () => {
  it("unchanged is answered silently", () => {
    const r = run(IDLE, start(save("s1", "me", "pw")), { type: "scanned", matches: [m("Logins/a.nqv", "me", "pw")], lookalike: null });
    expect(kinds(r.effects)).toEqual(["scan", "reply", "finish"]);
    expect(replies(r.effects)).toEqual([{ ok: true, status: "unchanged" }]);
  });

  it("a new login asks with a default name; an invalid name blocks Save", () => {
    let r = run(IDLE, start(save()), { type: "scanned", matches: [], lookalike: null });
    expect(r.state).toMatchObject({ stage: "save", name: "Example", plan: { kind: "create" } });
    expect(kinds(r.effects)).toEqual(["scan", "show"]);
    expect(step(r.state, { type: "confirmSave", nameOk: false }).effects).toEqual([]);
    r = run(r.state, { type: "name", value: "Mine" }, { type: "reveal" }, { type: "confirmSave", nameOk: true });
    expect(r.state).toMatchObject({ busy: true, reveal: true });
    expect(r.effects).toMatchObject([{ kind: "save", id: "s1", name: "Mine", plan: { kind: "create" } }]);
    expect(kinds(run(r.state, { type: "answered" }).effects)).toEqual(["finish"]);
  });

  it("a changed password asks to update; Not now answers denied", () => {
    const r = run(IDLE, start(save("s1", "me", "new")), { type: "scanned", matches: [m("Logins/a.nqv", "me", "old")], lookalike: null });
    expect(r.state).toMatchObject({ stage: "save", plan: { kind: "update" } });
    expect(step(r.state, { type: "confirmSave", nameOk: false }).effects[0]).toMatchObject({ kind: "save" }); // name unused
    expect(replies(step(r.state, { type: "deny" }).effects)).toEqual([{ error: "denied" }]);
  });

  it("locked first, then the save prompt", () => {
    const r = run(IDLE, start(save(), { unlocked: false }), { type: "unlocked" }, { type: "scanned", matches: [], lookalike: null });
    expect(r.state.stage).toBe("save");
    expect(kinds(r.effects)).toEqual(["show", "scan", "show"]);
  });
});

describe("waiting requests", () => {
  it("queues up to the limit, then rejects", () => {
    let q: Job[] = [];
    for (let i = 0; i < MAX_QUEUE; i++) {
      const r = enqueue(q, fill(`q${i}`));
      expect(r.rejected).toBeNull();
      q = r.queue;
    }
    const over = enqueue(q, fill("extra"));
    expect(over.rejected?.req.id).toBe("extra");
    expect(over.queue).toBe(q);
    expect(dropFromQueue(q, "q1").map((j) => j.req.id)).toEqual(["q0", "q2"]);
  });
});

describe("trust window reuse", () => {
  afterEach(() => clearTrust());
  it("an allowed-for-5-minutes host is trusted for the next request (which then fills silently)", () => {
    const a = m("Logins/a.nqv", "a");
    const first = run(IDLE, start(fill("f1")), { type: "scanned", matches: [a], lookalike: null },
      { type: "trust", on: true }, { type: "allow" });
    const release = first.effects.find((e) => e.kind === "release");
    expect(release).toMatchObject({ trustHost: "example.com" });
    // The window runs the release effect, which records the trust:
    trustHost((release as Extract<Effect, { kind: "release" }>).trustHost!);
    expect(isTrusted("example.com")).toBe(true);
    const second = run(IDLE, start(fill("f2"), { trusted: isTrusted("example.com") }),
      { type: "scanned", matches: [a], lookalike: null });
    expect(kinds(second.effects)).toEqual(["scan", "release"]);
    clearTrust(); // the vault locked
    expect(isTrusted("example.com")).toBe(false);
  });
});
