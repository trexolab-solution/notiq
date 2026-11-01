import { describe, expect, it } from "vitest";
import type { LoginMatch } from "../lib/autofill";
import { emptyLogin } from "../lib/loginEntry";
import { IDLE, step, type Effect, type Job, type PromptEvent, type PromptState } from "./promptMachine";

// The toolbar popup's password / 2FA-code copy (0.9.0) rides on the fill job: same approval, one named login.

const m = (rel: string, username: string, totp = ""): LoginMatch =>
  ({ path: `/root/${rel}`, rel, entry: { ...emptyLogin("T"), url: "https://example.com", username, password: `pw-${username}`, totp } });

const copy = (what: "password" | "code", account: string, id = "c1"): Job =>
  ({ kind: "fill", req: { id, host: "example.com", account, copy: what, ...(what === "code" ? { intent: "code" as const } : {}) } });

const start = (job: Job, o: Partial<{ unlocked: boolean; trusted: boolean }> = {}): PromptEvent =>
  ({ type: "start", job, exists: true, unlocked: o.unlocked ?? true, trusted: o.trusted ?? false });

function run(s: PromptState, ...events: PromptEvent[]) {
  const effects: Effect[] = [];
  // The vault scan the start asks for is left out: these tests are about what follows it.
  for (const ev of events) { const r = step(s, ev); s = r.state; effects.push(...r.effects.filter((e) => e.kind !== "scan")); }
  return { state: s, effects };
}
const replies = (fx: Effect[]) => fx.filter((e): e is Extract<Effect, { kind: "reply" }> => e.kind === "reply").map((e) => e.payload);

describe("popup copy through the prompt machine", () => {
  const a = m("Logins/a.nqv", "a"), b = m("Logins/b.nqv", "b", "JBSWY3DPEHPK3PXP");

  it("asks the user about exactly the named login, and the release carries the copy", () => {
    let r = run(IDLE, start(copy("password", "logins/B.nqv")), { type: "scanned", matches: [a, b], lookalike: null });
    expect(r.state).toMatchObject({ stage: "request", pick: 0 });
    expect(r.state.stage === "request" && r.state.matches).toEqual([b]);
    expect(r.effects.map((e) => e.kind)).toEqual(["show"]);
    r = run(r.state, { type: "allow" });
    expect(r.effects).toEqual([{ kind: "release", id: "c1", match: b, trustHost: null, copy: "password" }]);
  });

  it("a trusted site copies without the window (one named login, never a chooser)", () => {
    const r = run(IDLE, start(copy("password", "Logins/a.nqv"), { trusted: true }), { type: "scanned", matches: [a, b], lookalike: null });
    expect(r.effects).toEqual([{ kind: "release", id: "c1", match: a, trustHost: null, copy: "password" }]);
  });

  it("a stale account is refused, never swapped for another login", () => {
    const r = run(IDLE, start(copy("password", "Logins/gone.nqv"), { trusted: true }), { type: "scanned", matches: [a, b], lookalike: null });
    expect(replies(r.effects)).toEqual([{ error: "stale" }]);
    expect(r.effects.some((e) => e.kind === "release")).toBe(false);
    expect(r.state).toBe(IDLE);
  });

  it("a code copy only counts logins with a 2FA secret", () => {
    let r = run(IDLE, start(copy("code", "Logins/a.nqv"), { trusted: true }), { type: "scanned", matches: [a], lookalike: null });
    expect(replies(r.effects)).toEqual([{ error: "no_code" }]);
    r = run(IDLE, start(copy("code", "Logins/a.nqv"), { trusted: true }), { type: "scanned", matches: [a, b], lookalike: null });
    expect(replies(r.effects)).toEqual([{ error: "stale" }]);
    r = run(IDLE, start(copy("code", "Logins/b.nqv"), { trusted: true }), { type: "scanned", matches: [a, b], lookalike: null });
    expect(r.effects).toEqual([{ kind: "release", id: "c1", match: b, trustHost: null, intent: "code", copy: "code" }]);
  });

  it("locked: unlocking in the prompt counts as consent for the one named login", () => {
    let r = run(IDLE, start(copy("password", "Logins/b.nqv"), { unlocked: false }));
    expect(r.state.stage).toBe("locked");
    r = run(r.state, { type: "unlocked" }, { type: "scanned", matches: [a, b], lookalike: null });
    expect(r.effects).toEqual([{ kind: "release", id: "c1", match: b, trustHost: null, copy: "password" }]);
  });

  it("deny answers denied and copies nothing", () => {
    const r = run(IDLE, start(copy("password", "Logins/a.nqv")), { type: "scanned", matches: [a], lookalike: null }, { type: "deny" });
    expect(replies(r.effects)).toEqual([{ error: "denied" }]);
    expect(r.effects.some((e) => e.kind === "release")).toBe(false);
  });
});
