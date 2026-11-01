import { describe, expect, it } from "vitest";
import { totpCode } from "../lib/loginEntry";
import { toResult, type IndexItem } from "./rank";
import {
  codeLabel, codeTargets, copyPlan, formatCode, msUntilNextStep, NEAR_EXPIRY_SECONDS, secondsLeft, totpStep,
  waitingMessage,
} from "./totp";

const item = (rel: string, over: Partial<IndexItem> = {}): IndexItem => ({
  rel, ext: "login", tags: [], starred: false, updated: 0, host: "", urls: [], ...over,
});

describe("copyPlan (near-expiry choice)", () => {
  it("copies right away with 5 or more seconds left", () => {
    expect(NEAR_EXPIRY_SECONDS).toBe(5);
    for (const s of [30, 18, 6, 5]) expect(copyPlan(s)).toEqual({ kind: "now" });
  });

  it("waits for the next code with under 5 seconds left", () => {
    expect(copyPlan(4)).toEqual({ kind: "wait", seconds: 4 });
    expect(copyPlan(1)).toEqual({ kind: "wait", seconds: 1 });
    expect(copyPlan(0)).toEqual({ kind: "wait", seconds: 1 });
  });

  it("the wait ends exactly at the next step, which then has the full window", () => {
    const t = 1_700_000_037_400; // 2.6 s before a 30 s boundary
    expect(secondsLeft(t)).toBe(3);
    expect(copyPlan(secondsLeft(t)).kind).toBe("wait");
    const wait = msUntilNextStep(t);
    expect(wait).toBe(2_600);
    expect(totpStep(t + wait)).toBe(totpStep(t) + 1);
    expect(secondsLeft(t + wait)).toBe(30);
    expect(copyPlan(secondsLeft(t + wait))).toEqual({ kind: "now" });
  });
});

describe("steps and countdown", () => {
  it("matches the main editor's countdown", () => {
    expect(secondsLeft(0)).toBe(30);
    expect(secondsLeft(29_999)).toBe(1);
    expect(secondsLeft(30_000)).toBe(30);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
    expect(msUntilNextStep(30_000)).toBe(30_000);
  });

  it("uses the same RFC 6238 code as the Rust command (vector t=59 → 287082)", async () => {
    // Same vector as `totp_matches_rfc6238_vectors` in src-tauri/src/quick_search.rs.
    expect(await totpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000)).toBe("287082");
  });
});

describe("codeTargets", () => {
  const rows = [
    item("A.nqv", { totp: true }),
    item("B.nqv"),
    item("C.nqv", { totp: true }),
    item("Note.nqv", { ext: "md", totp: true }), // only logins have codes
    item("D.nqv", { totp: true }),
  ].map(toResult);

  it("only fetches codes for 2FA logins on screen", () => {
    expect(codeTargets(rows, 0)).toEqual(["A.nqv", "C.nqv", "D.nqv"]);
    expect(codeTargets(rows, 0, 3)).toEqual(["A.nqv", "C.nqv"]);
  });

  it("always includes the selected row, even below the fold", () => {
    expect(codeTargets(rows, 4, 2)).toEqual(["A.nqv", "D.nqv"]);
    expect(codeTargets(rows, 1, 0)).toEqual([]);
    expect(codeTargets([], 0)).toEqual([]);
  });
});

describe("labels", () => {
  it("names the code for screen readers without the digits", () => {
    expect(codeLabel("Google", 18)).toBe("2FA code for Google, 18 seconds left");
    expect(codeLabel("GitHub", 1)).toBe("2FA code for GitHub, 1 second left");
  });

  it("formats six digits in two groups", () => {
    expect(formatCode("123456")).toBe("123 456");
    expect(formatCode("12345678")).toBe("12345678");
  });

  it("status messages never contain a code", () => {
    expect(waitingMessage(3)).toBe("New 2FA code in 3 seconds, copying it then…");
    expect(waitingMessage(1)).toMatch(/1 second,/);
    expect(waitingMessage(2)).not.toMatch(/\d{6}/);
  });
});
