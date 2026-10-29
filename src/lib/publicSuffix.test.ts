import { describe, expect, it } from "vitest";
import { isIpAddress, isPublicSuffix, normalizeHost, publicSuffix, registrableDomain, siteMatches } from "./publicSuffix";

describe("normalizeHost", () => {
  it("lowercases and drops ports, trailing dots and IPv6 brackets", () => {
    expect(normalizeHost("Example.COM:8443")).toBe("example.com");
    expect(normalizeHost("example.com.")).toBe("example.com");
    expect(normalizeHost("[::1]:8080")).toBe("::1");
    expect(normalizeHost("fe80::1")).toBe("fe80::1");
  });
});

describe("publicSuffix / registrableDomain", () => {
  it("handles single-label TLDs", () => {
    expect(publicSuffix("www.example.com")).toBe("com");
    expect(registrableDomain("a.b.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
  });
  it("handles common multi-label suffixes", () => {
    const cases: [string, string][] = [
      ["www.bbc.co.uk", "bbc.co.uk"], ["login.ox.ac.uk", "ox.ac.uk"], ["www.gov.uk", "www.gov.uk"],
      ["shop.example.com.au", "example.com.au"], ["mail.example.co.in", "example.co.in"],
      ["x.example.co.jp", "example.co.jp"], ["loja.example.com.br", "example.com.br"],
      ["a.example.com.cn", "example.com.cn"], ["example.org.uk", "example.org.uk"],
      ["my.example.co.nz", "example.co.nz"], ["example.com.sg", "example.com.sg"],
      ["www.example.co.za", "example.co.za"], ["www.example.com.mx", "example.com.mx"],
      ["alice.github.io", "alice.github.io"], ["app.vercel.app", "app.vercel.app"],
    ];
    for (const [host, reg] of cases) expect(registrableDomain(host), host).toBe(reg);
  });
  it("returns null for suffixes, IPs, localhost and empty input", () => {
    for (const h of ["co.uk", "com", "github.io", "com.au", "192.168.1.1", "::1", "localhost", "app.localhost", ""]) {
      expect(registrableDomain(h), h).toBeNull();
    }
  });
  it("applies wildcard and exception rules", () => {
    expect(publicSuffix("shop.foo.ck")).toBe("foo.ck");
    expect(registrableDomain("shop.foo.ck")).toBe("shop.foo.ck");
    expect(registrableDomain("www.ck")).toBe("www.ck");
    expect(isPublicSuffix("anything.bd")).toBe(true);
    expect(registrableDomain("city.kawasaki.jp")).toBe("city.kawasaki.jp");
    expect(isPublicSuffix("foo.kawasaki.jp")).toBe(true);
  });
  it("detects IP addresses", () => {
    expect(isIpAddress("10.0.0.1")).toBe(true);
    expect(isIpAddress("[2001:db8::1]")).toBe(true);
    expect(isIpAddress("10.0.0.com")).toBe(false);
  });
});

describe("siteMatches", () => {
  it("matches exact hosts and subdomains of a registrable domain", () => {
    expect(siteMatches("example.com", "example.com")).toBe(true);
    expect(siteMatches("login.example.com", "example.com")).toBe(true);
    expect(siteMatches("a.login.example.co.uk", "login.example.co.uk")).toBe(true);
    expect(siteMatches("Example.com:443", "example.com")).toBe(true);
  });
  it("never matches every site under a public suffix", () => {
    expect(siteMatches("bbc.co.uk", "co.uk")).toBe(false);
    expect(siteMatches("evil.github.io", "github.io")).toBe(false);
    expect(siteMatches("x.com", "com")).toBe(false);
    expect(siteMatches("co.uk", "co.uk")).toBe(true); // exact still matches
  });
  it("IPs and localhost match only exactly (ports ignored)", () => {
    expect(siteMatches("192.168.1.1:8080", "192.168.1.1")).toBe(true);
    expect(siteMatches("1.192.168.1.1", "192.168.1.1")).toBe(false);
    expect(siteMatches("localhost:3000", "localhost")).toBe(true);
    expect(siteMatches("app.localhost", "localhost")).toBe(false);
  });
});
