import { describe, expect, it } from "vitest";
import type { IdentityMatch, LoginMatch } from "../lib/autofill";
import { identityFill } from "../lib/identityEntry";
import { emptyLogin } from "../lib/loginEntry";
import { emptySecret } from "../lib/secretEntry";
import { IDLE, step, type Effect, type Job, type PromptEvent, type PromptState } from "./promptMachine";

const ident = (rel: string, name = "Asha Rao"): IdentityMatch => {
  const entry = emptySecret("identity", "");
  entry.fields = { name, email: "asha@example.com", phone: "+91 98765 43210", address1: "12 MG Road", address2: "",
    city: "Bengaluru", state: "Karnataka", postal: "560001", country: "India", notes: "" };
  return { path: `/root/${rel}`, rel, entry, fill: identityFill(entry.fields)! };
};
const identity = (id = "i1", account?: string): Job =>
  ({ kind: "identity", req: { id, host: "shop.example.in", ...(account ? { account } : {}) } });
const start = (job: Job, o: Partial<{ exists: boolean; unlocked: boolean; trusted: boolean }> = {}): PromptEvent =>
  ({ type: "start", job, exists: o.exists ?? true, unlocked: o.unlocked ?? true, trusted: o.trusted ?? false });

function run(s: PromptState, ...events: PromptEvent[]) {
  const effects: Effect[] = [];
  for (const ev of events) { const r = step(s, ev); s = r.state; effects.push(...r.effects); }
  return { state: s, effects };
}
const kinds = (fx: Effect[]) => fx.map((e) => e.kind);
const replies = (fx: Effect[]) => fx.filter((e): e is Extract<Effect, { kind: "reply" }> => e.kind === "reply").map((e) => e.payload);

describe("prompt state machine: identity", () => {
  const home = ident("Identities/Home.nqv"), office = ident("Identities/Office.nqv", "Asha R");

  it("scans identities, shows the picker and releases only the picked one", () => {
    let r = run(IDLE, start(identity()));
    expect(r.state).toMatchObject({ stage: "checking", silent: false });
    expect(r.effects).toEqual([{ kind: "scanIdentities" }]);
    r = run(r.state, { type: "identitiesScanned", identities: [home, office] });
    expect(r.state).toMatchObject({ stage: "identity", pick: 0, busy: false });
    expect(kinds(r.effects)).toEqual(["show"]);
    r = run(r.state, { type: "pick", index: 9 });
    expect(r.state).toMatchObject({ pick: 1 });
    r = run(r.state, { type: "allow" });
    expect(r.effects).toEqual([{ kind: "releaseIdentity", id: "i1", identity: office }]);
    expect(step(r.state, { type: "deny" }).effects).toEqual([]); // busy
    r = run(r.state, { type: "answered" });
    expect(r.state).toBe(IDLE);
  });

  it("the requested account only pre-selects; the window is still shown", () => {
    const r = run(IDLE, start(identity("i1", "identities/office.nqv"), { trusted: true }),
      { type: "identitiesScanned", identities: [home, office] });
    expect(r.state).toMatchObject({ stage: "identity", pick: 1 });
    expect(kinds(r.effects)).toEqual(["scanIdentities", "show"]);
    // An unknown account falls back to the first identity.
    const r2 = run(IDLE, start(identity("i2", "Identities/Gone.nqv")), { type: "identitiesScanned", identities: [home, office] });
    expect(r2.state).toMatchObject({ stage: "identity", pick: 0 });
  });

  it("unlocking in the prompt shows the picker (no consent shortcut)", () => {
    let r = run(IDLE, start(identity(), { unlocked: false }));
    expect(r.state.stage).toBe("locked");
    r = run(r.state, { type: "unlocked" }, { type: "identitiesScanned", identities: [home] });
    expect(r.state.stage).toBe("identity");
    expect(r.effects.some((e) => e.kind === "releaseIdentity")).toBe(false);
  });

  it("no identities → no_identity without showing the window; deny / lock / failure", () => {
    expect(replies(run(IDLE, start(identity()), { type: "identitiesScanned", identities: [] }).effects)).toEqual([{ error: "no_identity" }]);
    const shown = run(IDLE, start(identity()), { type: "identitiesScanned", identities: [home] }).state;
    expect(replies(run(shown, { type: "deny" }).effects)).toEqual([{ error: "denied" }]);
    expect(replies(run(shown, { type: "vaultLocked" }).effects)).toEqual([{ error: "locked" }]);
    expect(replies(run(IDLE, start(identity()), { type: "failed" }).effects)).toEqual([{ error: "failed" }]);
  });

  it("login, card and identity results never cross", () => {
    const checking = run(IDLE, start(identity())).state;
    const login: LoginMatch = { path: "/root/a.nqv", rel: "a.nqv", entry: { ...emptyLogin("T"), url: "https://shop.example.in" } };
    expect(step(checking, { type: "scanned", matches: [login], lookalike: null })).toEqual({ state: checking, effects: [] });
    expect(step(checking, { type: "cardsScanned", cards: [] })).toEqual({ state: checking, effects: [] });
    const checkingCard = run(IDLE, start({ kind: "card", req: { id: "c1", host: "shop.example.in" } })).state;
    expect(step(checkingCard, { type: "identitiesScanned", identities: [home] })).toEqual({ state: checkingCard, effects: [] });
  });
});
