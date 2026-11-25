// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { getAuthPreference, setAuthPreference } from "./sshPreferredAuth";

describe("sshPreferredAuth", () => {
  beforeEach(() => localStorage.clear());

  it("asks by default", () => {
    expect(getAuthPreference("Servers/a.nqv")).toBe("ask");
    expect(getAuthPreference(undefined)).toBe("ask");
  });

  it("remembers a preferred method per server, ignoring path case and slashes", () => {
    setAuthPreference("Servers\\A.nqv", "key");
    expect(getAuthPreference("servers/a.nqv")).toBe("key");
    expect(getAuthPreference("servers/b.nqv")).toBe("ask");
  });

  it("goes back to asking when set to ask", () => {
    setAuthPreference("a.nqv", "password");
    setAuthPreference("a.nqv", "ask");
    expect(getAuthPreference("a.nqv")).toBe("ask");
  });
});
