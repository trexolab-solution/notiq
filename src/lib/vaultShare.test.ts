import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import {
  formatLife, importSummary, problemText, shareNoteLines, vaultShareImport, vaultShareInspect, withFolders,
  type ShareImportResult, type ShareInfo, type ShareItem,
} from "./vaultShare";

const HOUR = 3_600_000;
const info = (o: Partial<ShareInfo> = {}): ShareInfo => ({
  items: [], notes: 3, folders: 1, attachments: 0, validUntil: null, itemLifeMs: 7 * 24 * HOUR, itemUntil: null, deleteFile: true,
  vault: "ready", importsLeft: 1, problem: null, ...o,
});
const result = (o: Partial<ShareImportResult> = {}): ShareImportResult => ({
  added: 2, already: 0, expired: 0, importsLeft: 0, expiresAt: Date.UTC(2026, 11, 3, 14, 20), fileDeleted: true, deleteFailed: false, ...o,
});

describe("share import wrappers", () => {
  it("call the commands with the names Rust expects", async () => {
    vi.mocked(invoke).mockResolvedValue(null);
    await vaultShareInspect("C:/a.nqb", "pw");
    expect(invoke).toHaveBeenCalledWith("vault_share_inspect", { path: "C:/a.nqb", password: "pw" });
    await vaultShareImport("C:/a.nqb", "pw");
    expect(invoke).toHaveBeenCalledWith("vault_share_import", { path: "C:/a.nqb", password: "pw" });
  });
});

describe("share wording", () => {
  it("names a life in days when it is whole days, else in hours", () => {
    expect(formatLife(7 * 24 * HOUR)).toBe("7 days");
    expect(formatLife(24 * HOUR)).toBe("1 day");
    expect(formatLife(5 * HOUR)).toBe("5 hours");
    expect(formatLife(HOUR)).toBe("1 hour");
    expect(formatLife(30 * HOUR)).toBe("30 hours");
  });

  it("writes the note in short plain lines, only for what is set", () => {
    const now = Date.UTC(2026, 11, 1, 12, 0);
    const lines = shareNoteLines(info(), now);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^These items will be removed from your vault on .+ \(in 7 days\)\.$/);
    expect(lines[1]).toBe("This file can be imported 1 more time.");
    expect(lines[2]).toBe("After this import, the file is deleted from this computer.");
    expect(shareNoteLines(info({ importsLeft: 3 }), now)[1]).toBe("This file can be imported 3 more times.");
    expect(shareNoteLines(info({ importsLeft: 3 }), now)[2]).toBe("After the last import, the file is deleted from this computer.");
    expect(shareNoteLines(info({ itemLifeMs: null, deleteFile: false, importsLeft: null }), now)).toEqual([]);
    expect(shareNoteLines(info({ deleteFile: false }), now)).toHaveLength(2);
  });

  it("names the moment the items go when the sender set one, not a length of time", () => {
    const lines = shareNoteLines(info({ itemLifeMs: null, itemUntil: new Date(2026, 11, 1, 16, 0).getTime() }), Date.UTC(2026, 11, 1, 6, 0));
    expect(lines[0]).toMatch(/^These items will be removed from your vault on .+(4:00|16:00).*\.$/);
    expect(lines[0]).not.toMatch(/\(in /);
    expect(shareNoteLines(info({ itemLifeMs: 5 * HOUR, itemUntil: null }), Date.UTC(2026, 11, 1, 6, 0))[0]).toMatch(/\(in 5 hours\)/);
  });

  it("says why a file can't be imported", () => {
    expect(problemText("expired")).toMatch(/expired/);
    expect(problemText("noImportsLeft")).toMatch(/can't be imported again/);
    expect(problemText("clockBehind")).toMatch(/date and time/);
    expect(problemText("itemsEnded")).toMatch(/already passed/);
  });

  it("summarises an import", () => {
    expect(importSummary(result())).toMatch(/^Imported 2 notes\. They are removed on .+\.$/);
    expect(importSummary(result({ added: 1, expiresAt: null }))).toBe("Imported 1 note.");
    expect(importSummary(result({ added: 0, expired: 2, expiresAt: null }))).toMatch(/already been removed/);
    expect(importSummary(result({ added: 0, already: 2, expiresAt: null }))).toMatch(/already in your vault/);
  });
});

describe("the item list", () => {
  const note = (path: string, ext = "md"): ShareItem => ({ path, ext, dir: false, attachments: 0 });
  it("adds the folders a note sits in when the share has no entry for them, in path order", () => {
    const rows = withFolders([note("top.nqv"), note("Work/Bank/login.nqv", "login"), { path: "Work", ext: "", dir: true, attachments: 0 }]);
    expect(rows.map((r) => `${r.dir ? "d" : "f"}:${r.path}`)).toEqual(["f:top.nqv", "d:Work", "d:Work/Bank", "f:Work/Bank/login.nqv"]);
  });
  it("adds each missing folder once and leaves the ones that are there", () => {
    const rows = withFolders([note("A/x.nqv"), note("A/y.nqv"), { path: "A", ext: "", dir: true, attachments: 0 }]);
    expect(rows.filter((r) => r.dir)).toHaveLength(1);
    expect(withFolders([])).toEqual([]);
  });
});
