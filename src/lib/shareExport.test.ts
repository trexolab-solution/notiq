import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));
import {
  chooseAll, chosenCount, confirmProblem, coveredBy, defaultShareName, describeLimit, generateSharePassword, importsProblem, initialShareForm, itemLifeHours, itemsProblem,
  limitHours, limitMax, limitProblem, listForShare, passwordProblem, rulesProblem, shareFormProblem, shareSummary, toExportArgs, toggleChosen, validUntilMs,
  type ShareForm, type TimeLimit,
} from "./shareExport";
import type { VaultItem } from "./vault";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const days = (n: number): TimeLimit => ({ on: true, amount: n, unit: "days" });
const hours = (n: number): TimeLimit => ({ on: true, amount: n, unit: "hours" });
const off: TimeLimit = { on: false, amount: 7, unit: "days" };
const form = (o: Partial<ShareForm> = {}): ShareForm => ({ ...initialShareForm(["Work/bank.nqv"], "a password for sharing"), masterPassword: "the master password", ...o });
const item = (rel: string, o: Partial<VaultItem> = {}): VaultItem => ({
  rel, ext: rel.endsWith(".nqv") ? "md" : "", updated: 0, dir: !rel.endsWith(".nqv"), tags: [], starred: false, trashed_at: null, attachments: 0, history: 0, ...o,
});

describe("share form defaults", () => {
  it("starts with one import, a week for the file, a week for the items and the file deleted afterwards", () => {
    const f = initialShareForm(["a.nqv"]);
    expect(f).toMatchObject({ paths: ["a.nqv"], attachments: true, maxImports: 1, validFor: days(7), itemLife: days(7), deleteFile: true, masterPassword: "" });
    expect(f.sharePassword.length).toBeGreaterThanOrEqual(20);
  });
});

describe("time limits", () => {
  it("count in hours or days", () => {
    expect(limitHours(days(2))).toBe(48);
    expect(limitHours(hours(36))).toBe(36);
    expect(limitHours(off)).toBe(0);
  });
  it("turn into times", () => {
    const now = 1_000_000;
    expect(validUntilMs(hours(5), now)).toBe(now + 5 * HOUR);
    expect(validUntilMs(days(30), now)).toBe(now + 30 * DAY);
    expect(validUntilMs(off, now)).toBeNull();
    expect(itemLifeHours(days(7))).toBe(168);
    expect(itemLifeHours(hours(36))).toBe(36);
    expect(itemLifeHours(off)).toBeNull();
  });
  it("are checked: a whole number, at least 1, at most a year", () => {
    expect(limitMax("days")).toBe(365);
    expect(limitMax("hours")).toBe(8760);
    expect(limitProblem(days(7), "File expiry")).toBeNull();
    expect(limitProblem(days(365), "File expiry")).toBeNull();
    expect(limitProblem(hours(8760), "File expiry")).toBeNull();
    expect(limitProblem(days(366), "File expiry")).toBe("File expiry: enter 1 to 365 days.");
    expect(limitProblem(hours(8761), "Item removal")).toBe("Item removal: enter 1 to 8760 hours.");
    expect(limitProblem(days(0), "File expiry")).toBe("File expiry: enter 1 to 365 days.");
    expect(limitProblem(hours(1.5), "File expiry")).toMatch(/enter 1 to 8760 hours/);
    expect(limitProblem(hours(NaN), "File expiry")).toMatch(/enter 1 to 8760 hours/);
    expect(limitProblem({ ...off, amount: NaN }, "File expiry")).toBeNull();
  });
  it("the number of imports and the password have their own checks", () => {
    expect(importsProblem(1)).toBeNull();
    expect(importsProblem(100)).toBeNull();
    for (const bad of [0, 101, 1.5, NaN, -1]) expect(importsProblem(bad)).toBe("Number of imports: enter 1 to 100.");
    expect(passwordProblem("12345678")).toBeNull();
    expect(passwordProblem("1234567")).toMatch(/at least 8/);
  });
  it("read as words", () => {
    expect(describeLimit(days(7))).toBe("7 days");
    expect(describeLimit(days(1))).toBe("1 day");
    expect(describeLimit(hours(36))).toBe("36 hours");
    expect(describeLimit(hours(1))).toBe("1 hour");
  });
});

describe("share password", () => {
  it("is long, grouped, readable and different every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = generateSharePassword();
      expect(p).toMatch(/^[a-hjkmnp-z2-9]{5}(-[a-hjkmnp-z2-9]{5}){3}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(50);
  });
  it("never uses a byte that would make some characters likelier", () => {
    let calls = 0;
    const p = generateSharePassword((n) => { calls++; return calls === 1 ? new Uint8Array(n).fill(255) : new Uint8Array(n).fill(0); });
    expect(calls).toBe(2);
    expect(p).toBe("aaaaa-aaaaa-aaaaa-aaaaa");
  });
});

describe("choosing items", () => {
  it("a ticked folder covers what is under it", () => {
    expect(coveredBy(["Work"], "Work/bank.nqv")).toBe("Work");
    expect(coveredBy(["Work"], "Work")).toBeNull();
    expect(coveredBy(["Work"], "Workshop/a.nqv")).toBeNull();
    expect(coveredBy(["Work/a"], "Work/a.nqv")).toBeNull();
  });
  it("ticking a folder drops the notes under it; unticking removes it", () => {
    expect(toggleChosen(["Work/a.nqv", "top.nqv"], "Work", true)).toEqual(["top.nqv", "Work"]);
    expect(toggleChosen(["Work"], "Work/a.nqv", true)).toEqual(["Work"]);
    expect(toggleChosen(["Work"], "Work", true)).toEqual(["Work"]);
    expect(toggleChosen(["Work", "top.nqv"], "Work", false)).toEqual(["top.nqv"]);
  });
  it("Select all ticks everything shown, keeps the paths short, and unticks only what is shown", () => {
    const shown = [item("top.nqv"), item("Work"), item("Work/bank.nqv"), item("Work/mail.nqv")];
    expect(chooseAll([], shown, true)).toEqual(["top.nqv", "Work"]);
    expect(chooseAll(["Work/bank.nqv", "Other.nqv"], shown, true)).toEqual(["Other.nqv", "top.nqv", "Work"]);
    expect(chooseAll(["top.nqv", "Work", "Other.nqv"], shown, false)).toEqual(["Other.nqv"]);
    // A search shows part of the vault: only that part is ticked.
    expect(chooseAll([], [item("Work/bank.nqv")], true)).toEqual(["Work/bank.nqv"]);
    expect(chooseAll([], [], true)).toEqual([]);
  });
  it("counts what is ticked, by itself or through a folder", () => {
    const shown = [item("top.nqv"), item("Work"), item("Work/bank.nqv"), item("Work/mail.nqv")];
    expect(chosenCount([], shown)).toBe(0);
    expect(chosenCount(["Work"], shown)).toBe(3);
    expect(chosenCount(["Work/bank.nqv", "top.nqv"], shown)).toBe(2);
    expect(chosenCount(["top.nqv", "Work"], shown)).toBe(4);
  });
  it("lists the vault by path, without the recycle bin, and filters by a search", () => {
    const items = [item("top.nqv"), item("Work"), item("Work/bank.nqv"), item("gone.nqv", { trashed_at: 5 })];
    expect(listForShare(items, "").map((i) => i.rel)).toEqual(["top.nqv", "Work", "Work/bank.nqv"]);
    expect(listForShare(items, " BANK ").map((i) => i.rel)).toEqual(["Work/bank.nqv"]);
    expect(listForShare(items, "zzz")).toEqual([]);
  });
});

describe("step checks", () => {
  it("Items: something has to be chosen", () => {
    expect(itemsProblem(form())).toBeNull();
    expect(itemsProblem(form({ paths: [] }))).toMatch(/Choose what to share/);
  });
  it("Rules: the password, how often, and both time limits", () => {
    expect(rulesProblem(form())).toBeNull();
    expect(rulesProblem(form({ sharePassword: "short" }))).toMatch(/at least 8/);
    expect(rulesProblem(form({ maxImports: 0 }))).toMatch(/^Number of imports/);
    expect(rulesProblem(form({ maxImports: 101 }))).toMatch(/^Number of imports/);
    expect(rulesProblem(form({ maxImports: 1.5 }))).toMatch(/^Number of imports/);
    expect(rulesProblem(form({ maxImports: NaN }))).toMatch(/^Number of imports/);
    expect(rulesProblem(form({ validFor: days(0) }))).toMatch(/^File expiry:/);
    expect(rulesProblem(form({ itemLife: hours(9000) }))).toMatch(/^Item removal:/);
    expect(rulesProblem(form({ validFor: off, itemLife: off }))).toBeNull();
  });
  it("Confirm: the master password, and not the receiver's", () => {
    expect(confirmProblem(form())).toBeNull();
    expect(confirmProblem(form({ masterPassword: "" }))).toMatch(/master password/);
    expect(confirmProblem(form({ sharePassword: "same password", masterPassword: "same password" }))).toMatch(/different password/);
  });
  it("the whole form is the first problem of any step", () => {
    expect(shareFormProblem(form())).toBeNull();
    expect(shareFormProblem(form({ paths: [], sharePassword: "x" }))).toMatch(/Choose what to share/);
    expect(shareFormProblem(form({ sharePassword: "x" }))).toMatch(/at least 8/);
    expect(shareFormProblem(form({ masterPassword: "" }))).toMatch(/master password/);
  });
});

describe("summary", () => {
  const preview = { notes: 3, folders: 1, attachments: 2 };
  it("says what is shared and the rules in plain words", () => {
    const lines = shareSummary(form({ attachments: true, maxImports: 2, validFor: hours(36), itemLife: days(7) }), preview, 0);
    expect(lines).toEqual([
      "3 notes, 1 folder, 2 attachments", "Can be imported 2 times", "The file expires after 36 hours",
      "Items are removed 7 days after the import", "The file is deleted after its last import",
    ]);
  });
  it("names what is turned off", () => {
    const lines = shareSummary(form({ attachments: false, validFor: off, itemLife: off, deleteFile: false }), { notes: 1, folders: 0, attachments: 4 }, 0);
    expect(lines).toEqual(["1 note", "Can be imported 1 time", "The file never expires", "Items are never removed", "The file is kept after its last import"]);
    expect(shareSummary(form(), null, 0)[0]).toBe("Can be imported 1 time");
  });
});

describe("the export call", () => {
  it("carries every choice", () => {
    const now = 5_000_000;
    const args = toExportArgs(form({ attachments: true, maxImports: 3, validFor: hours(36), itemLife: days(1), deleteFile: false }), "C:/x.nqb", now);
    expect(args).toEqual({
      paths: ["Work/bank.nqv"], attachments: true, masterPassword: "the master password", sharePassword: "a password for sharing",
      maxImports: 3, validUntilMs: now + 36 * HOUR, itemLifeHours: 24, deleteFile: false, destPath: "C:/x.nqb",
    });
    expect(toExportArgs(form({ validFor: off, itemLife: off }), "C:/x.nqb", now)).toMatchObject({ validUntilMs: null, itemLifeHours: null });
  });
  it("names the file by local date", () => {
    expect(defaultShareName(new Date(2026, 10, 5))).toBe("notiq-share-2026-11-05.nqb");
  });
});
