import { describe, expect, it } from "vitest";
import { defaultLoginName, entryMatches, hostMatches, lookalikeWarning, planSave, type LoginMatch } from "./autofill";
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
  it("is public-suffix aware", () => {
    expect(hostMatches("www.bbc.co.uk", "bbc.co.uk")).toBe(true);
    expect(hostMatches("bbc.co.uk", "co.uk")).toBe(false);
    expect(hostMatches("anything.co.uk", "co.uk")).toBe(false);
    expect(hostMatches("me.github.io", "github.io")).toBe(false);
    expect(hostMatches("a.me.github.io", "me.github.io")).toBe(true);
  });
  it("matches IPs and localhost exactly, ignoring ports", () => {
    expect(hostMatches("127.0.0.1:5173", "127.0.0.1")).toBe(true);
    expect(hostMatches("x.127.0.0.1", "127.0.0.1")).toBe(false);
    expect(hostMatches("localhost:3000", "localhost")).toBe(true);
    expect(hostMatches("app.localhost", "localhost")).toBe(false);
  });
});

describe("entryMatches", () => {
  it("tests every URL of the login", () => {
    const e = { url: "https://example.com", urls: ["https://example.co.uk", "  "] };
    expect(entryMatches("login.example.co.uk", e)).toBe(true);
    expect(entryMatches("www.example.com", e)).toBe(true);
    expect(entryMatches("example.org", e)).toBe(false);
  });
});

describe("lookalikeWarning", () => {
  it("names both hosts", () => {
    expect(lookalikeWarning("paypa1.com", { saved: "paypal.com", reason: "homoglyph" }))
      .toBe("Blocked a possible fake site: paypa1.com looks like paypal.com");
  });
});
