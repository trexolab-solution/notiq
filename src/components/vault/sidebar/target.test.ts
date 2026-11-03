import { describe, expect, it } from "vitest";
import { anyExpanded, relOfKey, targetFolderOf } from "./target";

const FOLDERS = ["Work", "Work/AWS", "Home"];
const isFolder = (rel: string) => FOLDERS.includes(rel);

describe("targetFolderOf (where New item / New folder create)", () => {
  it("nothing selected → the vault root", () => {
    expect(targetFolderOf(null, isFolder)).toBe("");
  });
  it("a folder selected → inside it (tree or starred row)", () => {
    expect(targetFolderOf("t:Work/AWS", isFolder)).toBe("Work/AWS");
    expect(targetFolderOf("s:Home", isFolder)).toBe("Home");
  });
  it("an entry selected → its parent folder; a root entry → the root", () => {
    expect(targetFolderOf("t:Work/AWS/prod.nqv", isFolder)).toBe("Work/AWS");
    expect(targetFolderOf("s:Work/key.nqv", isFolder)).toBe("Work");
    expect(targetFolderOf("t:bank.nqv", isFolder)).toBe("");
  });
  it("a site-group row → the folder the group is in", () => {
    expect(targetFolderOf("g:Work/@site:github.com", isFolder)).toBe("Work");
    expect(targetFolderOf("g:@site:github.com", isFolder)).toBe("");
  });
  it("relOfKey ignores site groups", () => {
    expect(relOfKey("g:Work/@site:x.com")).toBeNull();
    expect(relOfKey("t:Work")).toBe("Work");
    expect(relOfKey(null)).toBeNull();
  });
});

describe("anyExpanded (Collapse all / Expand all toggle)", () => {
  it("is false with nothing open, or only stale entries for folders that no longer exist", () => {
    expect(anyExpanded(new Set(), FOLDERS)).toBe(false);
    expect(anyExpanded(new Set(["Gone"]), FOLDERS)).toBe(false);
  });
  it("is true with an open folder (case-insensitive)", () => {
    expect(anyExpanded(new Set(["work"]), FOLDERS)).toBe(true);
  });
  it("counts an open root site group, but not one hidden inside a closed folder", () => {
    expect(anyExpanded(new Set(["@site:github.com"]), FOLDERS)).toBe(true);
    expect(anyExpanded(new Set(["Work/@site:github.com"]), FOLDERS)).toBe(false);
  });
});
