import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));
import {
  coveredBy, defaultShareName, generateSharePassword, initialShareForm, itemLifeHours, listForShare, shareFormProblem,
  toExportArgs, toggleChosen, validUntilMs, type ShareForm,
} from "./shareExport";
import type { VaultItem } from "./vault";

const DAY = 86_400_000;
const form = (o: Partial<ShareForm> = {}): ShareForm => ({ ...initialShareForm(["Work/bank.nqv"], "a password for sharing"), masterPassword: "the master password", ...o });
const item = (rel: string, o: Partial<VaultItem> = {}): VaultItem => ({
  rel, ext: rel.endsWith(".nqv") ? "md" : "", updated: 0, dir: !rel.endsWith(".nqv"), tags: [], starred: false, trashed_at: null, attachments: 0, history: 0, ...o,
});

describe("share form defaults", () => {
  it("starts with one import, a week for the file, a week for the items and the file deleted afterwards", () => {
    const f = initialShareForm(["a.nqv"]);
    expect(f).toMatchObject({ paths: ["a.nqv"], attachments: false, maxImports: 1, validFor: "7d", itemLife: "7d", deleteFile: true, masterPassword: "" });
    expect(f.sharePassword.length).toBeGreaterThanOrEqual(20);
  });
  it("turns the choices into times", () => {
    const now = 1_000_000;
    expect(validUntilMs("1d", now)).toBe(now + DAY);
    expect(validUntilMs("30d", now)).toBe(now + 30 * DAY);
    expect(validUntilMs("never", now)).toBeNull();
    expect(itemLifeHours("7d")).toBe(168);
    expect(itemLifeHours("1d")).toBe(24);
    expect(itemLifeHours("forever")).toBeNull();
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
    // Bytes of 248 and over are skipped; with only such bytes first, the next batch is used.
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
  it("lists the vault by path, without the recycle bin, and filters by a search", () => {
    const items = [item("top.nqv"), item("Work"), item("Work/bank.nqv"), item("gone.nqv", { trashed_at: 5 })];
    expect(listForShare(items, "").map((i) => i.rel)).toEqual(["top.nqv", "Work", "Work/bank.nqv"]);
    expect(listForShare(items, " BANK ").map((i) => i.rel)).toEqual(["Work/bank.nqv"]);
    expect(listForShare(items, "zzz")).toEqual([]);
  });
});

describe("share form checks", () => {
  it("accepts a complete form", () => {
    expect(shareFormProblem(form())).toBeNull();
  });
  it("names what is missing, one thing at a time", () => {
    expect(shareFormProblem(form({ paths: [] }))).toMatch(/Choose what to share/);
    expect(shareFormProblem(form({ sharePassword: "short" }))).toMatch(/at least 8/);
    expect(shareFormProblem(form({ sharePassword: "same password", masterPassword: "same password" }))).toMatch(/different password/);
    expect(shareFormProblem(form({ maxImports: 0 }))).toMatch(/between 1 and 100/);
    expect(shareFormProblem(form({ maxImports: 101 }))).toMatch(/between 1 and 100/);
    expect(shareFormProblem(form({ maxImports: 1.5 }))).toMatch(/between 1 and 100/);
    expect(shareFormProblem(form({ masterPassword: "" }))).toMatch(/master password/);
  });
});

describe("the export call", () => {
  it("carries every choice", () => {
    const now = 5_000_000;
    const args = toExportArgs(form({ attachments: true, maxImports: 3, validFor: "30d", itemLife: "1d", deleteFile: false }), "C:/x.nqb", now);
    expect(args).toEqual({
      paths: ["Work/bank.nqv"], attachments: true, masterPassword: "the master password", sharePassword: "a password for sharing",
      maxImports: 3, validUntilMs: now + 30 * DAY, itemLifeHours: 24, deleteFile: false, destPath: "C:/x.nqb",
    });
    expect(toExportArgs(form({ validFor: "never", itemLife: "forever" }), "C:/x.nqb", now)).toMatchObject({ validUntilMs: null, itemLifeHours: null });
  });
  it("names the file by local date", () => {
    expect(defaultShareName(new Date(2026, 10, 5))).toBe("notiq-share-2026-11-05.nqb");
  });
});
