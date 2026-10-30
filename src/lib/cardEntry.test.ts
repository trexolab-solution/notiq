import { describe, expect, it } from "vitest";
import { cardExpired, cardFill, expiryParts, maskCardNumber } from "./cardEntry";

describe("card autofill helpers", () => {
  it("masks all but the last four digits", () => {
    expect(maskCardNumber("4242 4242 4242 4242")).toBe("•••• 4242");
    expect(maskCardNumber("3782-822463-10005")).toBe("•••• 0005");
    expect(maskCardNumber("1234")).toBe("••••"); // too short to show anything
    expect(maskCardNumber("")).toBe("••••");
  });

  it("splits MM/YY into a two-digit month and a four-digit year", () => {
    expect(expiryParts("08/27")).toEqual({ month: "08", year: "2027" });
    expect(expiryParts(" 12/31 ")).toEqual({ month: "12", year: "2031" });
    for (const bad of ["", "8/27", "13/27", "00/27", "08/2027", "0827", "ab/cd"]) expect(expiryParts(bad)).toBeNull();
  });

  it("builds the fill payload from the stored fields", () => {
    expect(cardFill({ cardholder: " Ann\u0007Lee ", number: "4242 4242 4242 4242", expiry: "08/27", cvv: "123", pin: "9999" }))
      .toEqual({ name: "Ann Lee", number: "4242424242424242", exp_month: "08", exp_year: "2027", csc: "123" });
  });

  it("leaves out what the card lacks and never sends a bad number", () => {
    expect(cardFill({ number: "5555555555554444" }))
      .toEqual({ name: "", number: "5555555555554444", exp_month: "", exp_year: "", csc: "" });
    expect(cardFill({ number: "4242424242424242", expiry: "garbage", cvv: "12" })).toMatchObject({ exp_month: "", csc: "" });
    expect(cardFill({ number: "4242424242424242", cvv: "12345" })?.csc).toBe("");
    expect(cardFill({ number: "4242" })).toBeNull();
    expect(cardFill({ number: "1".repeat(20) })).toBeNull();
    expect(cardFill({})).toBeNull();
    expect(cardFill({ number: "4242424242424242", cardholder: "x".repeat(300) })?.name).toHaveLength(100);
  });

  it("knows when a card has expired (valid through the end of its month)", () => {
    const now = new Date(2026, 9, 30); // 30 Oct 2026
    expect(cardExpired({ exp_month: "10", exp_year: "2026" }, now)).toBe(false);
    expect(cardExpired({ exp_month: "09", exp_year: "2026" }, now)).toBe(true);
    expect(cardExpired({ exp_month: "01", exp_year: "2030" }, now)).toBe(false);
    expect(cardExpired({ exp_month: "", exp_year: "" }, now)).toBe(false);
  });
});
