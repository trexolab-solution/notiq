import { describe, expect, it } from "vitest";
import { customFillFields, fillReply, MAX_CUSTOM_FILL_VALUE, type LoginMatch } from "./autofill";
import { emptyLogin } from "./loginEntry";

describe("custom fields in the fill reply", () => {
  const login = (custom: { label: string; value: string; secret: boolean }[], totp = ""): LoginMatch =>
    ({ path: "/v/Logins/bank.nqv", rel: "Logins/bank.nqv",
       entry: { ...emptyLogin("Bank"), username: "me", password: "pw", totp, custom } });

  it("customFillFields keeps named fields with a value, drops blanks and oversized values", () => {
    const f = customFillFields({ custom: [
      { label: " Customer ID ", value: "C-123", secret: false },
      { label: "PIN", value: "4321", secret: true },
      { label: "", value: "nameless", secret: false },
      { label: "Empty", value: "", secret: false },
      { label: "Huge", value: "x".repeat(MAX_CUSTOM_FILL_VALUE + 1), secret: false },
      { label: "Bell", value: "a\u0007b", secret: false },
      { label: "Address", value: "line 1\nline 2", secret: false },
    ] });
    expect(f).toEqual([
      { name: "Customer ID", value: "C-123", secret: false },
      { name: "PIN", value: "4321", secret: true },
      { name: "Address", value: "line 1\nline 2", secret: false },
    ]);
    expect(customFillFields({})).toEqual([]);
  });

  it("a login fill carries the custom fields (secret flag included)", async () => {
    const r = await fillReply(login([{ label: "Customer ID", value: "C-1", secret: false }, { label: "PIN", value: "9", secret: true }]));
    expect(r).toEqual({
      ok: true, username: "me", password: "pw", title: "Bank",
      fields: [{ name: "Customer ID", value: "C-1", secret: false }, { name: "PIN", value: "9", secret: true }],
    });
  });

  it("no custom fields: the reply has no fields key (older shape)", async () => {
    expect(await fillReply(login([]))).toEqual({ ok: true, username: "me", password: "pw", title: "Bank" });
  });

  it("a code-only fill never carries custom fields", async () => {
    const r = await fillReply(login([{ label: "PIN", value: "9", secret: true }], "JBSWY3DPEHPK3PXP"), "code");
    expect(r).not.toHaveProperty("fields");
    expect(JSON.stringify(r)).not.toContain("PIN");
  });
});
