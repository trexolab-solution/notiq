import { afterEach, describe, expect, it } from "vitest";
import {
  clearLoginUsage, clearTrust, fillReply, hasSaveChoice, loginLastUsed, markLoginUsed, pickSaveTarget,
  planSave, saveCandidateLabel, setSaveAsNew, type LoginMatch,
} from "./autofill";
import { emptyLogin } from "./loginEntry";

const m = (rel: string, username: string, password: string, updated = 0, title = "T"): LoginMatch =>
  ({ path: `/v/${rel}`, rel, updated, entry: { ...emptyLogin(title), url: "https://bank.example", username, password } });

afterEach(() => clearLoginUsage());

describe("planSave: several logins with this username", () => {
  it("returns every same-username login as a candidate, most recently used first", () => {
    const a = m("Logins/a.nqv", "me", "1", 300);
    const b = m("Logins/b.nqv", "ME", "2", 100);
    const c = m("Logins/c.nqv", "me ", "3", 200);
    const other = m("Logins/o.nqv", "you", "4", 999);
    const used = new Map([[b.path, 50], [c.path, 10]]);
    const p = planSave([a, other, b, c], { username: "me", password: "new" }, (x) => used.get(x.path) ?? 0);
    expect(p.kind).toBe("update");
    expect(p.candidates).toEqual([b, c, a]);
    expect(p.target).toBe(b);
  });

  it("without usage, orders by last modified, then vault order", () => {
    const a = m("Logins/a.nqv", "me", "1", 100);
    const b = m("Logins/b.nqv", "me", "2", 300);
    const c = m("Logins/c.nqv", "me", "3"); // no timestamp
    const d = m("Logins/d.nqv", "me", "4");
    const p = planSave([c, a, d, b], { username: "me", password: "new" }, () => 0);
    expect(p.candidates).toEqual([b, a, c, d]);
    expect(p.target).toBe(b);
  });

  it("uses the logins filled in this session by default (markLoginUsed / fillReply)", async () => {
    const a = m("Logins/a.nqv", "me", "1", 500);
    const b = m("Logins/b.nqv", "me", "2", 100);
    expect(planSave([a, b], { username: "me", password: "x" }).target).toBe(a);
    await fillReply(b);
    expect(loginLastUsed(b)).toBeGreaterThan(0);
    expect(planSave([a, b], { username: "me", password: "x" }).target).toBe(b);
    markLoginUsed(a, Date.now() + 1000);
    expect(planSave([a, b], { username: "me", password: "x" }).target).toBe(a);
  });

  it("usage is forgotten when the vault locks (clearTrust)", () => {
    const a = m("Logins/a.nqv", "me", "1");
    markLoginUsed(a);
    clearTrust();
    expect(loginLastUsed(a)).toBe(0);
  });

  it("single candidate: same plan as before (no choice offered)", () => {
    const a = m("Logins/a.nqv", "me", "old");
    const p = planSave([a], { username: "me", password: "new" });
    expect(p).toMatchObject({ kind: "update", target: a });
    expect(hasSaveChoice(p)).toBe(false);
  });

  it("any candidate with the same password still means unchanged", () => {
    const p = planSave([m("a.nqv", "me", "1"), m("b.nqv", "me", "same")], { username: "me", password: "same" });
    expect(p).toEqual({ kind: "unchanged" });
  });

  it("create plans carry no candidates", () => {
    expect(planSave([m("a.nqv", "me", "1")], { username: "you", password: "x" })).toEqual({ kind: "create" });
  });
});

describe("choosing the login to update", () => {
  const a = m("Logins/a.nqv", "me", "1", 200, "Bank");
  const b = m("Work/b.nqv", "me", "2", 100, "Bank");
  const c = m("Logins/c.nqv", "me", "3", 50, "Bank (old)");
  const plan = planSave([a, b, c], { username: "me", password: "new" }, () => 0);

  it("pickSaveTarget switches the target; out of range is ignored", () => {
    expect(hasSaveChoice(plan)).toBe(true);
    expect(pickSaveTarget(plan, 1)).toMatchObject({ kind: "update", target: b, candidates: [a, b, c] });
    expect(pickSaveTarget(plan, 7)).toBe(plan);
    expect(pickSaveTarget({ kind: "create" }, 0)).toEqual({ kind: "create" });
  });

  it("Save as new turns the plan into a create and back, keeping the chosen login", () => {
    const picked = pickSaveTarget(plan, 2);
    const asNew = setSaveAsNew(picked, true);
    expect(asNew.kind).toBe("create");
    expect(asNew.candidates).toEqual([a, b, c]);
    const back = setSaveAsNew(asNew, false);
    expect(back).toMatchObject({ kind: "update", target: c });
    // Only for plans that offered candidates.
    expect(setSaveAsNew({ kind: "create" }, false)).toEqual({ kind: "create" });
  });

  it("labels repeat titles with their vault path", () => {
    expect(saveCandidateLabel(a, [a, b, c])).toBe("Bank (Logins/a)");
    expect(saveCandidateLabel(b, [a, b, c])).toBe("Bank (Work/b)");
    expect(saveCandidateLabel(c, [a, b, c])).toBe("Bank (old)");
  });
});
