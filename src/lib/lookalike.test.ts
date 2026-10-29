import { describe, expect, it } from "vitest";
import { decodeLabel, editDistance, lookalikeOf, punycodeDecode, skeleton } from "./lookalike";

const puny = (unicodeHost: string) => new URL(`https://${unicodeHost}/`).hostname;

describe("punycode", () => {
  it("decodes labels produced by the URL parser", () => {
    const h = puny("pаypal.com"); // Cyrillic а
    expect(h.startsWith("xn--")).toBe(true);
    expect(decodeLabel(h.split(".")[0])).toBe("pаypal");
    expect(punycodeDecode(puny("bücher.de").split(".")[0].slice(4))).toBe("bücher");
  });
  it("rejects malformed input", () => {
    expect(punycodeDecode("!!!")).toBeNull();
    expect(decodeLabel("plain")).toBe("plain");
  });
});

describe("skeleton / editDistance", () => {
  it("folds look-alike characters", () => {
    expect(skeleton("paypa1")).toBe(skeleton("paypal"));
    expect(skeleton("rnicrosoft")).toBe(skeleton("microsoft"));
    expect(skeleton("g00gle")).toBe(skeleton("google"));
    expect(skeleton("vvikipedia")).toBe(skeleton("wikipedia"));
    expect(skeleton("аpple")).toBe(skeleton("apple"));
  });
  it("computes Levenshtein distance", () => {
    expect(editDistance("kitten", "sitting")).toBe(3);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("abcdef", "xyz", 1)).toBe(2);
  });
});

describe("lookalikeOf", () => {
  const saved = ["paypal.com", "accounts.google.com", "github.com", "bbc.co.uk", "x.com"];

  it("flags punycode / confusable hosts", () => {
    expect(lookalikeOf(puny("pаypal.com"), saved)).toEqual({ saved: "paypal.com", reason: "punycode" });
  });
  it("flags homoglyph substitutions", () => {
    expect(lookalikeOf("paypa1.com", saved)?.reason).toBe("homoglyph");
    expect(lookalikeOf("g00gle.com", saved)).toEqual({ saved: "accounts.google.com", reason: "homoglyph" });
    expect(lookalikeOf("glthub.com", saved)?.reason).toBe("homoglyph");
  });
  it("flags the same name under a different TLD", () => {
    expect(lookalikeOf("paypal.co", saved)).toEqual({ saved: "paypal.com", reason: "tld" });
    expect(lookalikeOf("login.bbc.com", saved)).toEqual({ saved: "bbc.co.uk", reason: "tld" });
  });
  it("flags small spelling differences on long enough names", () => {
    expect(lookalikeOf("paypall.com", saved)?.reason).toBe("spelling");
    expect(lookalikeOf("githbu.com", saved)?.reason).toBe("spelling");
  });
  it("flags the real domain used as a subdomain", () => {
    expect(lookalikeOf("paypal.com.secure-login.io", saved)?.reason).toBe("subdomain");
  });
  it("does not flag real matches, same-site hosts or unrelated sites", () => {
    expect(lookalikeOf("www.paypal.com", saved)).toBeNull();
    expect(lookalikeOf("mail.google.com", saved)).toBeNull(); // same registrable domain
    expect(lookalikeOf("example.org", saved)).toBeNull();
    expect(lookalikeOf("y.com", saved)).toBeNull(); // too short for spelling checks
    expect(lookalikeOf("192.168.0.1", saved)).toBeNull();
    expect(lookalikeOf("localhost", saved)).toBeNull();
    expect(lookalikeOf("paypal.com", [])).toBeNull();
  });
});
