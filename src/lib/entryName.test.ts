import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./vaultDir", () => ({ ensureVaultDir: vi.fn(async () => "C:\\V\\") }));
const list = vi.fn();
vi.mock("./vault", async (orig) => ({ ...(await orig<typeof import("./vault")>()), vaultList: () => list() }));

import {
  entryTitleOf, isStructuredEntryTab, isStructuredExt, planEntryName, sanitizeEntryName, withEntryTitle,
} from "./entryName";
import { planEntryRename } from "./entrySync";
import { emptyLogin, parseLogin, serializeLogin } from "./loginEntry";
import { emptySecret, serializeSecret } from "./secretEntry";
import { emptyCodes, serializeCodes } from "./recoveryCodes";

const item = (rel: string, dir = false) => ({ rel, ext: dir ? "" : "login", updated: 0, dir, tags: [], starred: false, trashed_at: null, attachments: 0, history: 0 });

describe("sanitizeEntryName", () => {
  it("replaces characters a name can't hold and tidies spaces", () => {
    expect(sanitizeEntryName("  Work: Gmail / personal  ")).toBe("Work Gmail personal");
    expect(sanitizeEntryName('a*b?c"d<e>f|g\\h')).toBe("a b c d e f g h");
    expect(sanitizeEntryName("tab\there\nnew")).toBe("tab here new");
  });
  it("drops a typed .nqv and trailing dots", () => {
    expect(sanitizeEntryName("GitHub.nqv")).toBe("GitHub");
    expect(sanitizeEntryName("Bank...")).toBe("Bank");
    expect(sanitizeEntryName(".env")).toBe(".env");
  });
  it("returns empty when nothing usable is left", () => {
    expect(sanitizeEntryName("")).toBe("");
    expect(sanitizeEntryName("   ")).toBe("");
    expect(sanitizeEntryName("///")).toBe("");
    expect(sanitizeEntryName("...")).toBe("");
  });
  it("caps the length", () => {
    expect(sanitizeEntryName("x".repeat(300))).toHaveLength(120);
  });
});

describe("planEntryName", () => {
  it("uses the Name when it's free", () => {
    expect(planEntryName("GitHub", "New login", ["New login", "Bank"])).toBe("GitHub");
  });
  it("keeps the old name when the Name is empty or unusable", () => {
    expect(planEntryName("", "New login", ["New login"])).toBe("New login");
    expect(planEntryName(" / ", "New login", ["New login"])).toBe("New login");
  });
  it("allows a change of letter case only", () => {
    expect(planEntryName("github", "GitHub", ["GitHub"])).toBe("github");
  });
  it("adds a number on a clash with a sibling, like new items do", () => {
    expect(planEntryName("Bank", "New login", ["New login", "Bank"])).toBe("Bank 2");
    expect(planEntryName("bank", "New login", ["New login", "Bank", "Bank 2"])).toBe("bank 3");
  });
  it("is stable: an entry already named 'Bank 2' stays so", () => {
    expect(planEntryName("Bank", "Bank 2", ["Bank", "Bank 2"])).toBe("Bank 2");
    expect(planEntryName("Bank 2", "Bank 2", ["Bank", "Bank 2"])).toBe("Bank 2");
  });
});

describe("entry title in JSON", () => {
  it("reads and writes the title of every structured kind", () => {
    for (const raw of [
      serializeLogin(emptyLogin("a")), serializeSecret(emptySecret("ssh", "a")),
      serializeSecret(emptySecret("card", "a")), serializeCodes(emptyCodes("a")),
    ]) {
      expect(entryTitleOf(raw)).toBe("a");
      const next = withEntryTitle(raw, "b");
      expect(entryTitleOf(next)).toBe("b");
      expect({ ...JSON.parse(next), title: "a" }).toEqual(JSON.parse(raw));
    }
  });
  it("keeps every other field", () => {
    const raw = serializeLogin({ ...emptyLogin("Old"), username: "me", password: "pw" });
    const p = parseLogin(withEntryTitle(raw, "New"));
    expect([p.title, p.username, p.password]).toEqual(["New", "me", "pw"]);
  });
  it("leaves content that isn't a JSON object alone", () => {
    expect(entryTitleOf("# just markdown")).toBeNull();
    expect(withEntryTitle("# just markdown", "x")).toBe("# just markdown");
    expect(withEntryTitle("[1,2]", "x")).toBe("[1,2]");
  });
});

describe("structured kinds", () => {
  it("knows which file types have a Name", () => {
    for (const k of ["login", "ssh", "secret", "card", "wifi", "identity", "codes"]) expect(isStructuredExt(k)).toBe(true);
    expect(isStructuredExt("md")).toBe(false);
    expect(isStructuredExt(undefined)).toBe(false);
    expect(isStructuredEntryTab({ filePath: "C:/V/a.nqv", vaultExt: "login" })).toBe(true);
    expect(isStructuredEntryTab({ filePath: "C:/V/a.nqv", vaultExt: "md" })).toBe(false);
    expect(isStructuredEntryTab({ filePath: "C:/notes/a.json", vaultExt: "login" })).toBe(false);
  });
});

describe("planEntryRename", () => {
  beforeEach(() => list.mockReset());

  it("doesn't list the vault when the Name already matches", async () => {
    expect(await planEntryRename("C:/V/Logins/GitHub.nqv", "GitHub")).toEqual({ name: "GitHub", to: "C:/V/Logins/GitHub.nqv" });
    expect(list).not.toHaveBeenCalled();
  });
  it("renames within the same folder, numbering on a clash", async () => {
    list.mockResolvedValue([item("Logins", true), item("Logins/New login.nqv"), item("Logins/Bank.nqv"), item("Bank 2.nqv")]);
    expect(await planEntryRename("C:/V/Logins/New login.nqv", "Bank")).toEqual({ name: "Bank 2", to: "C:/V/Logins/Bank 2.nqv" });
    expect(await planEntryRename("C:/V/Logins/New login.nqv", "Work/Bank")).toEqual({ name: "Work Bank", to: "C:/V/Logins/Work Bank.nqv" });
  });
  it("keeps the name when the Name is empty", async () => {
    expect(await planEntryRename("C:/V/a.nqv", "  ")).toEqual({ name: "a", to: "C:/V/a.nqv" });
  });
  it("returns null for a path outside the vault", async () => {
    expect(await planEntryRename("D:/elsewhere/a.nqv", "b")).toBeNull();
  });
});
