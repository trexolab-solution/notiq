import { describe, expect, it } from "vitest";
import { escapeWifi, wifiQrText } from "./wifiEntry";

describe("escapeWifi", () => {
  it("escapes backslash, semicolon, comma, colon and quote", () => {
    expect(escapeWifi('a\\b;c,d:e"f')).toBe('a\\\\b\\;c\\,d\\:e\\"f');
  });
});

describe("wifiQrText", () => {
  it("is null without an SSID", () => {
    expect(wifiQrText({})).toBeNull();
    expect(wifiQrText({ ssid: "", password: "x" })).toBeNull();
  });
  it("defaults to WPA with password", () => {
    expect(wifiQrText({ ssid: "Home", password: "pw" })).toBe("WIFI:T:WPA;S:Home;P:pw;;");
  });
  it("maps security types", () => {
    expect(wifiQrText({ ssid: "a", password: "p", security: "WPA3" })).toBe("WIFI:T:WPA;S:a;P:p;;");
    expect(wifiQrText({ ssid: "a", password: "p", security: "WEP" })).toBe("WIFI:T:WEP;S:a;P:p;;");
  });
  it("omits the password for open networks", () => {
    expect(wifiQrText({ ssid: "a", password: "p", security: "Open" })).toBe("WIFI:T:nopass;S:a;;");
  });
  it("adds the hidden flag and escapes values", () => {
    expect(wifiQrText({ ssid: "a;b", password: "c:d", hidden: "true" })).toBe("WIFI:T:WPA;S:a\\;b;P:c\\:d;H:true;;");
    expect(wifiQrText({ ssid: "a", hidden: "false" })).toBe("WIFI:T:WPA;S:a;;");
  });
});
