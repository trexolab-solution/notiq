import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getUnlockMethod, setUnlockMethod } from "./unlockMethod";

function stubStorage(store: Record<string, string>) {
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = v; },
  });
}

describe("unlockMethod", () => {
  let store: Record<string, string>;
  beforeEach(() => { store = {}; stubStorage(store); });
  afterEach(() => vi.unstubAllGlobals());

  it("defaults to Windows Hello", () => expect(getUnlockMethod()).toBe("hello"));

  it("remembers the last choice", () => {
    setUnlockMethod("password");
    expect(getUnlockMethod()).toBe("password");
    setUnlockMethod("hello");
    expect(getUnlockMethod()).toBe("hello");
  });

  it("ignores junk values", () => {
    store["vault:unlockMethod"] = "<script>";
    expect(getUnlockMethod()).toBe("hello");
  });

  it("survives unavailable storage", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); } });
    expect(getUnlockMethod()).toBe("hello");
    expect(() => setUnlockMethod("password")).not.toThrow();
  });
});
