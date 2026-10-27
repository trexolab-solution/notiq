import { describe, expect, it } from "vitest";
import { hostMatches } from "./autofill";

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
