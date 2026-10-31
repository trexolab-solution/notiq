import { describe, expect, it } from "vitest";
import type { LoginMatch } from "../lib/autofill";
import { emptyLogin } from "../lib/loginEntry";
import { IDLE, step, type Effect, type Job, type PromptEvent, type PromptState } from "./promptMachine";

const m = (rel: string, username: string, password: string, updated: number): LoginMatch =>
  ({ path: `/root/${rel}`, rel, updated, entry: { ...emptyLogin(rel), url: "https://example.com", username, password } });
const save = (username = "me", password = "new"): Job =>
  ({ kind: "save", req: { id: "s1", host: "example.com", url: "https://example.com/login", username, password, title: "Example" } });
const start = (job: Job): PromptEvent => ({ type: "start", job, exists: true, unlocked: true, trusted: false });

function run(s: PromptState, ...events: PromptEvent[]) {
  const effects: Effect[] = [];
  for (const ev of events) { const r = step(s, ev); s = r.state; effects.push(...r.effects); }
  return { state: s, effects };
}

describe("prompt state machine: choosing which login to update", () => {
  const a = m("Logins/a.nqv", "me", "1", 100);
  const b = m("Logins/b.nqv", "me", "2", 300);
  const c = m("Logins/c.nqv", "me", "3", 200);
  const scanned: PromptEvent = { type: "scanned", matches: [a, b, c], lookalike: null };

  it("pre-selects the best candidate and saves to the one the user picks", () => {
    let r = run(IDLE, start(save()), scanned);
    expect(r.state).toMatchObject({ stage: "save", plan: { kind: "update", target: b, candidates: [b, c, a] } });
    r = run(r.state, { type: "saveTarget", index: 2 }, { type: "confirmSave", nameOk: false });
    expect(r.effects).toEqual([{ kind: "save", id: "s1", req: save().req, name: "Example", plan: expect.objectContaining({ kind: "update", target: a }) }]);
  });

  it("Save as new needs a valid name and writes a new login", () => {
    let r = run(IDLE, start(save()), scanned, { type: "saveAsNew", on: true });
    expect(r.state).toMatchObject({ stage: "save", plan: { kind: "create" } });
    expect(run(r.state, { type: "confirmSave", nameOk: false }).effects).toEqual([]);
    r = run(r.state, { type: "name", value: "Second" }, { type: "confirmSave", nameOk: true });
    expect(r.effects).toMatchObject([{ kind: "save", name: "Second", plan: { kind: "create" } }]);
  });

  it("back from Save as new restores the picked login", () => {
    const r = run(IDLE, start(save()), scanned, { type: "saveTarget", index: 1 }, { type: "saveAsNew", on: true }, { type: "saveAsNew", on: false });
    expect(r.state).toMatchObject({ plan: { kind: "update", target: c } });
  });

  it("ignores picks while saving and outside the save stage", () => {
    let r = run(IDLE, start(save()), scanned, { type: "confirmSave", nameOk: true });
    expect(r.state).toMatchObject({ busy: true });
    r = run(r.state, { type: "saveTarget", index: 2 }, { type: "saveAsNew", on: true });
    expect(r.state).toMatchObject({ plan: { kind: "update", target: b } });
    expect(step(IDLE, { type: "saveTarget", index: 0 }).state).toBe(IDLE);
  });
});
