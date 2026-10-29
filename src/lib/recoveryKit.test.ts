import { describe, expect, it } from "vitest";
import {
  buildRecoveryKitHtml, formatFingerprint, groupRecoveryKey, keyRows, KIT_CHECKLIST, KIT_INSTRUCTIONS,
} from "./recoveryKit";

// Same shape the backend produces: 52 Crockford base32 chars in dash-separated groups of 4.
const KEY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789-ABCD-EFGH-JKMN-PQRS-TVWX";

describe("groupRecoveryKey", () => {
  it("splits into groups of 4 and drops separators", () => {
    const g = groupRecoveryKey(KEY);
    expect(g).toHaveLength(13);
    expect(g[0]).toBe("ABCD");
    expect(g.join("-")).toBe(KEY);
  });

  it("normalises case and whitespace; keeps a short tail group", () => {
    expect(groupRecoveryKey(" abcd efgh\nij ")).toEqual(["ABCD", "EFGH", "IJ"]);
    expect(groupRecoveryKey("")).toEqual([]);
  });
});

describe("keyRows", () => {
  it("lays groups out 4 per line", () => {
    const rows = keyRows(groupRecoveryKey(KEY));
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4, 1]);
    expect(keyRows(["A", "B", "C"], 2)).toEqual([["A", "B"], ["C"]]);
  });
});

describe("formatFingerprint", () => {
  it("takes the first 8 hex chars", () => {
    expect(formatFingerprint("0a1b2c3d4e5f60718293a4b5c6d7e8f9")).toBe("0A1B 2C3D");
    expect(formatFingerprint("0A1B2C3D")).toBe("0A1B 2C3D");
    expect(formatFingerprint("0A1B 2C3D")).toBe("0A1B 2C3D"); // already formatted
    expect(formatFingerprint("xyz")).toBe("");
  });
});

describe("buildRecoveryKitHtml", () => {
  const html = buildRecoveryKitHtml({ recoveryKey: KEY, fingerprint: "0a1b2c3d4e5f", createdAt: new Date(2026, 9, 29) });

  it("contains the branding, date, fingerprint and every key group", () => {
    expect(html).toContain("Notiq");
    expect(html).toContain("Recovery Kit");
    expect(html).toContain("October 29, 2026");
    expect(html).toContain("0A1B 2C3D");
    for (const g of groupRecoveryKey(KEY)) expect(html).toContain(`<span>${g}</span>`);
    expect(html).toMatch(/monospace/);
  });

  it("explains the key, never asks for the master password, and has the checklist", () => {
    for (const t of KIT_INSTRUCTIONS) expect(html).toContain(t.replace(/&/g, "&amp;"));
    for (const t of KIT_CHECKLIST) expect(html).toContain(t);
    expect(html).toMatch(/master password is NOT on this page/);
    expect(html).toMatch(/AND a copy of your vault file/);
    expect(html.toLowerCase()).not.toMatch(/write (down )?your master password|password hint/);
  });

  it("escapes dynamic values", () => {
    const evil = buildRecoveryKitHtml({ recoveryKey: "<script>", fingerprint: "\"><img>", createdAt: new Date(0) });
    expect(evil).not.toContain("<script>");
    expect(evil).not.toContain("<img>");
    expect(evil).toContain("—"); // unusable fingerprint shows a dash
  });
});
