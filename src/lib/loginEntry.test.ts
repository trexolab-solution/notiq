import { describe, expect, it } from "vitest";
import { emptyLogin, generatePassword, hostOf, loginUrls, parseLogin, serializeLogin, totpCode } from "./loginEntry";

describe("loginEntry", () => {
  it("round-trips and tolerates garbage", () => {
    const e = { ...emptyLogin("Gmail"), username: "me", password: "pw" };
    expect(parseLogin(serializeLogin(e))).toEqual(e);
    expect(parseLogin("not json").kind).toBe("login");
    expect(parseLogin('{"title":5,"password":"x"}').title).toBe("");
  });

  it("extracts hosts", () => {
    expect(hostOf("https://Accounts.Google.com/signin")).toBe("accounts.google.com");
    expect(hostOf("github.com")).toBe("github.com");
    expect(hostOf("")).toBe("");
  });

  it("generates passwords with every class and the requested length", () => {
    const p = generatePassword(24);
    expect(p).toHaveLength(24);
    expect(p).toMatch(/[a-z]/); expect(p).toMatch(/[A-Z]/); expect(p).toMatch(/[2-9]/); expect(p).toMatch(/[^a-zA-Z0-9]/);
    expect(generatePassword(24)).not.toBe(p);
    expect(generatePassword(16, false)).toMatch(/^[a-zA-Z0-9]+$/);
  });

  it("matches the RFC 6238 SHA-1 test vector", async () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
    expect(await totpCode(secret, 59_000, 8)).toBe("94287082");
    expect(await totpCode(secret, 1_111_111_109_000, 8)).toBe("07081804");
    expect(await totpCode("not base32!", 0)).toBeNull();
  });
});

describe("login urls", () => {
  it("old entries without urls still parse", () => {
    const e = parseLogin(JSON.stringify({ v: 1, kind: "login", title: "t", url: "a.com", username: "u", password: "p", totp: "", notes: "" }));
    expect(e.urls).toEqual([]);
    expect(loginUrls(e)).toEqual(["a.com"]);
  });

  it("round-trips extra urls and cleans blanks/duplicates", () => {
    const e = { ...emptyLogin("x"), url: "https://a.com", urls: ["b.com", " ", "B.COM", "c.org"] };
    expect(loginUrls(parseLogin(serializeLogin(e)))).toEqual(["https://a.com", "b.com", "c.org"]);
  });

  it("ignores non-string urls entries", () => {
    expect(parseLogin('{"url":"a.com","urls":[1,null,"b.com"]}').urls).toEqual(["b.com"]);
  });
});
