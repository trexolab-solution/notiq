import { describe, expect, it } from "vitest";
import { emptySecret, parseSecret, serializeSecret } from "./secretEntry";
import { emptyLogin, extraUrlError, parseLogin, serializeLogin } from "./loginEntry";
import { MAX_CUSTOM_FIELDS, MAX_CUSTOM_LABEL, parseCustomFields } from "./customFields";
import { cardBrand, cardNumberHint, expiryError, formatCardNumber, formatExpiry, luhnValid } from "./cardEntry";
import { escapeWifi, wifiQrText } from "./wifiEntry";
import {
  addCodes, emptyCodes, MAX_CODES, nextUnused, parseCodes, remainingCount, removeCode, serializeCodes, splitCodes, toggleUsed,
} from "./recoveryCodes";
import { attachmentLimitError, fileNameOf } from "./attachmentLimits";
import { previewRows } from "./entryPreview";
import { VAULT_ATTACH_MAX_BYTES, VAULT_ATTACH_MAX_PER_NOTE, VAULT_ATTACH_MAX_TOTAL } from "./vault";

describe("card / wifi entries (schema)", () => {
  it("round-trips a card with custom fields", () => {
    const e = emptySecret("card", "Visa");
    e.fields.number = "4111 1111 1111 1111";
    e.fields.expiry = "08/29";
    e.custom = [{ label: "Bank phone", value: "0800", secret: false }, { label: "Online PIN", value: "9", secret: true }];
    const back = parseSecret("card", serializeSecret(e));
    expect(back).toEqual({ ...e, fields: { ...back.fields, number: "4111 1111 1111 1111", expiry: "08/29" } });
    expect(back.fields.cvv).toBe("");
    expect(back.custom).toHaveLength(2);
  });

  it("round-trips wifi incl. select + checkbox values", () => {
    const e = emptySecret("wifi", "Home");
    Object.assign(e.fields, { ssid: "Net", password: "pw", security: "WPA3", hidden: "true" });
    const back = parseSecret("wifi", serializeSecret(e));
    expect(back.fields).toMatchObject({ ssid: "Net", password: "pw", security: "WPA3", hidden: "true", notes: "" });
  });

  it("old-shape entries (no custom) still load", () => {
    const old = JSON.stringify({ v: 1, kind: "secret", title: "k", fields: { key: "abc" } });
    const e = parseSecret("secret", old);
    expect(e.custom).toEqual([]);
    expect(e.fields.key).toBe("abc");
    expect(parseSecret("card", "garbage").custom).toEqual([]);
  });

  it("login keeps custom fields and tolerates old entries", () => {
    const e = { ...emptyLogin("x"), custom: [{ label: "Q", value: "A", secret: true }] };
    expect(parseLogin(serializeLogin(e))).toEqual(e);
    expect(parseLogin('{"title":"t"}').custom).toEqual([]);
  });
});

describe("custom fields parse", () => {
  it("drops junk, clips labels, caps the count", () => {
    expect(parseCustomFields("nope")).toEqual([]);
    expect(parseCustomFields([null, 1, { label: 5, value: "v", secret: "yes" }])).toEqual([{ label: "", value: "v", secret: false }]);
    expect(parseCustomFields([{ label: "x".repeat(100), value: "" }])[0].label).toHaveLength(MAX_CUSTOM_LABEL);
    expect(parseCustomFields(Array.from({ length: 30 }, () => ({ label: "a", value: "b" })))).toHaveLength(MAX_CUSTOM_FIELDS);
  });
});

describe("card helpers", () => {
  it("luhn", () => {
    expect(luhnValid("4111 1111 1111 1111")).toBe(true);
    expect(luhnValid("4111 1111 1111 1112")).toBe(false);
    expect(luhnValid("378282246310005")).toBe(true);
    expect(luhnValid("1234")).toBe(false);
    expect(cardNumberHint("4111 1111 1111 1112")).toMatch(/checksum/);
    expect(cardNumberHint("4111 1111 1111 1111")).toBeNull();
    expect(cardNumberHint("4111")).toBeNull();
  });

  it("brand from prefix", () => {
    expect(cardBrand("4111")).toBe("Visa");
    expect(cardBrand("5500 0000")).toBe("Mastercard");
    expect(cardBrand("2221 00")).toBe("Mastercard");
    expect(cardBrand("3782")).toBe("American Express");
    expect(cardBrand("6011")).toBe("Discover");
    expect(cardBrand("3530")).toBe("JCB");
    expect(cardBrand("")).toBeNull();
    expect(cardBrand("9999")).toBeNull();
  });

  it("formats numbers and expiry", () => {
    expect(formatCardNumber("4111111111111111")).toBe("4111 1111 1111 1111");
    expect(formatCardNumber("378282246310005")).toBe("3782 822463 10005");
    expect(formatCardNumber("41a1-1")).toBe("4111");
    expect(formatExpiry("1229")).toBe("12/29");
    expect(formatExpiry("12/")).toBe("12");
    expect(formatExpiry("1")).toBe("1");
  });

  it("validates expiry", () => {
    const now = new Date(2026, 9, 15); // Oct 2026
    expect(expiryError("", now)).toBeNull();
    expect(expiryError("10/26", now)).toBeNull();
    expect(expiryError("09/26", now)).toMatch(/expired/);
    expect(expiryError("13/30", now)).toMatch(/Month/);
    expect(expiryError("1/30", now)).toMatch(/MM\/YY/);
  });
});

describe("wifi QR text", () => {
  it("escapes special characters", () => {
    expect(escapeWifi(`a;b,c:d"e\\f`)).toBe(`a\\;b\\,c\\:d\\"e\\\\f`);
  });
  it("builds the payload", () => {
    expect(wifiQrText({ ssid: "Home", password: "p;w", security: "WPA2" })).toBe("WIFI:T:WPA;S:Home;P:p\\;w;;");
    expect(wifiQrText({ ssid: "Home", password: "x", security: "WPA3", hidden: "true" })).toBe("WIFI:T:WPA;S:Home;P:x;H:true;;");
    expect(wifiQrText({ ssid: "Cafe", password: "ignored", security: "Open" })).toBe("WIFI:T:nopass;S:Cafe;;");
    expect(wifiQrText({ ssid: "Old", password: "k", security: "WEP" })).toBe("WIFI:T:WEP;S:Old;P:k;;");
    expect(wifiQrText({ ssid: "D", password: "k" })).toBe("WIFI:T:WPA;S:D;P:k;;");
    expect(wifiQrText({ ssid: "" })).toBeNull();
  });
});

describe("recovery codes", () => {
  it("round-trips and tolerates old/odd shapes", () => {
    const e = { ...emptyCodes("GitHub"), service: "GitHub", codes: [{ code: "a", used: true }, { code: "b", used: false }] };
    expect(parseCodes(serializeCodes(e))).toEqual(e);
    expect(parseCodes('{"codes":["x"," ",{"code":"y","used":true},null,5]}').codes).toEqual([
      { code: "x", used: false }, { code: "y", used: true },
    ]);
    expect(parseCodes("bad").kind).toBe("codes");
  });

  it("splits pasted text and skips duplicates", () => {
    expect(splitCodes("aaaa-bbbb  cccc\n\ndddd,eeee;ffff\r\n")).toEqual(["aaaa-bbbb", "cccc", "dddd", "eeee", "ffff"]);
    const r = addCodes([{ code: "AAA", used: true }], "aaa bbb bbb ccc");
    expect(r.codes.map((c) => c.code)).toEqual(["AAA", "bbb", "ccc"]);
    expect(r.added).toBe(2);
    expect(r.skipped).toBe(2);
  });

  it("caps the list", () => {
    const many = Array.from({ length: MAX_CODES + 5 }, (_, i) => `c${i}`).join(" ");
    const r = addCodes([], many);
    expect(r.codes).toHaveLength(MAX_CODES);
    expect(r.skipped).toBe(5);
  });

  it("tracks used / next unused / remaining", () => {
    let list = addCodes([], "a b c").codes;
    expect(nextUnused(list)).toBe(0);
    list = toggleUsed(list, 0);
    expect(nextUnused(list)).toBe(1);
    expect(remainingCount(list)).toBe(2);
    list = toggleUsed(toggleUsed(list, 1), 2);
    expect(nextUnused(list)).toBe(-1);
    expect(remainingCount(list)).toBe(0);
    expect(removeCode(list, 1).map((c) => c.code)).toEqual(["a", "c"]);
  });
});

describe("attachment limits", () => {
  it("checks size, count and vault total", () => {
    expect(attachmentLimitError(1000, 0, 0)).toBeNull();
    expect(attachmentLimitError(VAULT_ATTACH_MAX_BYTES, 0, 0)).toBeNull();
    expect(attachmentLimitError(VAULT_ATTACH_MAX_BYTES + 1, 0, 0)).toMatch(/5 MB each/);
    expect(attachmentLimitError(10, VAULT_ATTACH_MAX_PER_NOTE, 0)).toMatch(/at most 20/);
    expect(attachmentLimitError(2, 0, VAULT_ATTACH_MAX_TOTAL - 1)).toMatch(/25 MB/);
    expect(attachmentLimitError(1, 0, VAULT_ATTACH_MAX_TOTAL - 1)).toBeNull();
  });
  it("takes the file name from any path", () => {
    expect(fileNameOf("C:\\Users\\me\\scan.pdf")).toBe("scan.pdf");
    expect(fileNameOf("/home/me/id.png")).toBe("id.png");
  });
});

describe("login other sites", () => {
  const e = { ...emptyLogin(), url: "https://a.com", urls: ["b.com"] };
  it("validates", () => {
    expect(extraUrlError("c.org", e)).toBeNull();
    expect(extraUrlError("https://login.c.co.uk/x", e)).toBeNull();
    expect(extraUrlError("", e)).toMatch(/Enter/);
    expect(extraUrlError("not a site", e)).toMatch(/doesn't look/);
    expect(extraUrlError("A.com/path", e)).toMatch(/already/);
    expect(extraUrlError("https://b.com", e)).toMatch(/already/);
    expect(extraUrlError("d.com", { url: "", urls: Array.from({ length: 20 }, (_, i) => `s${i}.com`) })).toMatch(/At most/);
  });
});

describe("history preview rows", () => {
  it("masks secrets and drops empties", () => {
    const rows = previewRows("login", serializeLogin({ ...emptyLogin("G"), username: "me", password: "pw" }));
    expect(rows).toEqual([
      { label: "Name", value: "G", secret: false },
      { label: "Username", value: "me", secret: false },
      { label: "Password", value: "pw", secret: true },
    ]);
    const card = emptySecret("card", "C"); card.fields.number = "4111"; card.fields.zip = "1";
    expect(previewRows("card", serializeSecret(card)).find((r) => r.label === "Card number")?.secret).toBe(true);
    expect(previewRows("md", "hello")).toEqual([{ label: "Content", value: "hello", secret: true }]);
  });
});
