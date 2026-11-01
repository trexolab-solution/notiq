import { describe, expect, it } from "vitest";
import { assessMasterPassword, masterPasswordProblem } from "./masterPassword";

describe("masterPasswordProblem", () => {
  it("rejects short passwords", () => {
    expect(masterPasswordProblem("Ab1!xyz")).toMatch(/at least 8/);
  });
  it("rejects common passwords", () => {
    expect(masterPasswordProblem("password1")).toMatch(/common/);
  });
  it("rejects low-score passwords", () => {
    expect(masterPasswordProblem("aaaaaaaaaa")).not.toBeNull();
    expect(masterPasswordProblem("12345678")).not.toBeNull();
  });
  it("accepts strong passwords", () => {
    expect(masterPasswordProblem("correct horse battery staple")).toBeNull();
    expect(masterPasswordProblem("t7#Vq!9zLm2@")).toBeNull();
  });
  it("reports label and hint", () => {
    const r = assessMasterPassword("password1");
    expect(r.ok).toBe(false);
    expect(r.hint).toBe("Avoid common passwords");
  });
});
