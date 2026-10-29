import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  browserRegState, clearTrust, decideTrusted, indexOfAccount, isTrusted, TRUST_MS, trustedHosts, trustHost,
  validAccount, type LoginMatch,
} from "./autofill";
import { emptyLogin } from "./loginEntry";

const m = (rel: string, username: string, title = "T"): LoginMatch =>
  ({ path: `/root/${rel}`, rel, entry: { ...emptyLogin(title), url: "https://example.com", username, password: `pw-${username}` } });

describe("trust window", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); clearTrust(); });
  afterEach(() => { clearTrust(); vi.useRealTimers(); });

  it("lasts 5 minutes", () => {
    trustHost("example.com");
    expect(isTrusted("example.com")).toBe(true);
    vi.advanceTimersByTime(TRUST_MS - 1);
    expect(isTrusted("example.com")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isTrusted("example.com")).toBe(false);
  });

  it("the sweep timer drops expired hosts", () => {
    trustHost("a.com");
    vi.advanceTimersByTime(60_000);
    trustHost("b.com");
    vi.advanceTimersByTime(TRUST_MS - 60_000);
    expect(trustedHosts()).toEqual(["b.com"]);
    vi.advanceTimersByTime(60_000);
    expect(trustedHosts()).toEqual([]);
  });

  it("is cleared by a lock (clearTrust)", () => {
    trustHost("example.com");
    clearTrust();
    expect(isTrusted("example.com")).toBe(false);
  });

  it("is exact: no subdomains, look-alikes or parents", () => {
    trustHost("example.com");
    expect(isTrusted("EXAMPLE.com")).toBe(true);
    expect(isTrusted("sub.example.com")).toBe(false);
    expect(isTrusted("evil-example.com")).toBe(false);
    expect(isTrusted("example.com.evil.io")).toBe(false);
    trustHost("login.example.com");
    expect(isTrusted("example.com")).toBe(true);
    clearTrust();
    trustHost("login.example.com");
    expect(isTrusted("example.com")).toBe(false);
  });

  it("re-trusting extends the window", () => {
    trustHost("example.com");
    vi.advanceTimersByTime(TRUST_MS - 1000);
    trustHost("example.com");
    vi.advanceTimersByTime(2000);
    expect(isTrusted("example.com")).toBe(true);
  });
});

describe("decideTrusted", () => {
  it("never reveals anything without matches", () => {
    expect(decideTrusted([], "Logins/a.nqv")).toEqual({ kind: "no_match" });
    expect(decideTrusted([], undefined)).toEqual({ kind: "no_match" });
  });

  it("fills the single match", () => {
    const a = m("Logins/a.nqv", "me");
    expect(decideTrusted([a], undefined)).toEqual({ kind: "fill", match: a });
  });

  it("lists several matches without secrets", () => {
    const d = decideTrusted([m("Logins/a.nqv", "me", "A"), m("Logins/b.nqv", "you", "B")], undefined);
    expect(d).toEqual({ kind: "choose", options: [
      { account: "Logins/a.nqv", title: "A", username: "me" },
      { account: "Logins/b.nqv", title: "B", username: "you" },
    ] });
    expect(JSON.stringify(d)).not.toContain("pw-");
  });

  it("fills the requested account (case-insensitive, slashes normalised)", () => {
    const b = m("Logins/b.nqv", "you");
    expect(decideTrusted([m("Logins/a.nqv", "me"), b], "logins\\B.nqv")).toEqual({ kind: "fill", match: b });
  });

  it("ignores an account that isn't among the host's matches", () => {
    const d = decideTrusted([m("Logins/a.nqv", "me"), m("Logins/b.nqv", "you")], "Logins/other-site.nqv");
    expect(d.kind).toBe("choose");
    expect(decideTrusted([m("Logins/a.nqv", "me")], "Logins/other-site.nqv").kind).toBe("fill");
  });
});

describe("account validation", () => {
  it("accepts relative paths and rejects traversal, absolute and control chars", () => {
    expect(validAccount("Logins/a.nqv")).toBe("Logins/a.nqv");
    expect(validAccount("")).toBeNull();
    expect(validAccount(5)).toBeNull();
    expect(validAccount("../a.nqv")).toBeNull();
    expect(validAccount("/a.nqv")).toBeNull();
    expect(validAccount("C:\\a.nqv")).toBeNull();
    expect(validAccount("a\u0007b")).toBeNull();
    expect(validAccount("x".repeat(513))).toBeNull();
  });

  it("preselects the requested account in the dialog", () => {
    const list = [m("Logins/a.nqv", "me"), m("Logins/b.nqv", "you")];
    expect(indexOfAccount(list, "Logins/b.nqv")).toBe(1);
    expect(indexOfAccount(list, "Logins/zzz.nqv")).toBe(-1);
    expect(indexOfAccount(list, undefined)).toBe(-1);
  });
});

describe("browserRegState", () => {
  const b = { name: "Chrome", installed: true, registered: true, manifest_path: "x", path_matches_current_exe: true, ids_ok: true };
  it("maps registration to one state", () => {
    expect(browserRegState(b)).toBe("ok");
    expect(browserRegState({ ...b, registered: false })).toBe("missing");
    expect(browserRegState({ ...b, path_matches_current_exe: false })).toBe("other_copy");
    expect(browserRegState({ ...b, ids_ok: false })).toBe("outdated");
  });
});
