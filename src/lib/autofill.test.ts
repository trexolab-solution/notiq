import { describe, expect, it } from "vitest";
import { defaultLoginName, hostMatches, planSave, type LoginMatch } from "./autofill";
import { emptyLogin } from "./loginEntry";

const m = (username: string, password: string, path = "r/a.nqv"): LoginMatch =>
  ({ path, entry: { ...emptyLogin("t"), url: "https://example.com", username, password } });

describe("planSave", () => {
  it("is unchanged for same user and password (case-insensitive user)", () => {
    expect(planSave([m("Me@x.io", "pw")], { username: "me@x.io", password: "pw" }).kind).toBe("unchanged");
  });
  it("updates when the password differs", () => {
    const a = m("me", "old");
    const p = planSave([m("other", "z", "r/b.nqv"), a], { username: "ME", password: "new" });
    expect(p.kind).toBe("update");
    expect(p.target).toBe(a);
  });
  it("creates for a new user or no entries", () => {
    expect(planSave([m("me", "pw")], { username: "you", password: "pw" }).kind).toBe("create");
    expect(planSave([], { username: "me", password: "pw" }).kind).toBe("create");
  });
  it("empty username only matches an empty-username entry", () => {
    expect(planSave([m("me", "pw")], { username: "", password: "pw" }).kind).toBe("create");
    expect(planSave([m("", "pw")], { username: "", password: "pw" }).kind).toBe("unchanged");
  });
});

describe("defaultLoginName", () => {
  it("strips invalid characters and falls back to the host", () => {
    expect(defaultLoginName('Sign in: a/b?', "x.com")).toBe("Sign in a b");
    expect(defaultLoginName("  ", "x.com")).toBe("x.com");
  });
});

describe("hostMatches", () => {
  it("matches the exact host and subdomains", () => {
    expect(hostMatches("example.com", "example.com")).toBe(true);
    expect(hostMatches("login.example.com", "example.com")).toBe(true);
  });
  it("never matches look-alikes or parents", () => {
    expect(hostMatches("evilexample.com", "example.com")).toBe(false);
    expect(hostMatches("example.com.evil.io", "example.com")).toBe(false);
    expect(hostMatches("example.com", "login.example.com")).toBe(false);
    expect(hostMatches("example.com", "")).toBe(false);
  });
});
