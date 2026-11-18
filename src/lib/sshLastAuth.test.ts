import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
});
const { getLastSshAuth, setLastSshAuth } = await import("./sshLastAuth");

describe("sshLastAuth", () => {
  beforeEach(() => store.clear());

  it("remembers the last method per server", () => {
    expect(getLastSshAuth("C:/v/Alpha.nqv")).toBeNull();
    setLastSshAuth("C:/v/Alpha.nqv", "password");
    setLastSshAuth("C:/v/Beta.nqv", "key");
    expect(getLastSshAuth("C:/v/Alpha.nqv")).toBe("password");
    expect(getLastSshAuth("C:/v/Beta.nqv")).toBe("key");
    setLastSshAuth("C:/v/Alpha.nqv", "key");
    expect(getLastSshAuth("C:/v/Alpha.nqv")).toBe("key");
  });

  it("ignores path case and slash style", () => {
    setLastSshAuth(["C:", "v", "Alpha.nqv"].join(String.fromCharCode(92)), "password");
    expect(getLastSshAuth("c:/V/alpha.NQV")).toBe("password");
  });

  it("tolerates junk and a missing path", () => {
    store.set("pref:sshLastAuth", "{not json");
    expect(getLastSshAuth("x.nqv")).toBeNull();
    expect(getLastSshAuth(undefined)).toBeNull();
    expect(() => setLastSshAuth(undefined, "key")).not.toThrow();
  });
});
