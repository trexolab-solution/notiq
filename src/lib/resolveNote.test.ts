import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import { fileBasename, normNote, resolveNoteHref } from "./resolveNote";

const tab = (id: string, title: string, extra: Partial<Tab> = {}) => ({ id, kind: "note", title, ...extra }) as Tab;

describe("normNote", () => {
  it("normalises case, extension, separators, fragments and encoding", () => {
    expect(normNote("My%20Note.MD#section")).toBe("my note");
    expect(normNote("a-b_c   d.md?x=1")).toBe("a b c d");
    expect(normNote("dir\\Sub.md")).toBe("dir/sub");
  });
});

describe("fileBasename", () => {
  it("decodes and strips directories", () => {
    expect(fileBasename("sub%20dir/note.md")).toBe("note.md");
  });
});

describe("resolveNoteHref", () => {
  const tabs = [
    tab("1", "Project Plan"),
    tab("2", "ideas"),
    tab("3", "Untitled", { filePath: "C:\\docs\\Disk-File.md" }),
    tab("4", "Project Plan", { kind: "settings" }),
  ];
  it("returns undefined for external and fragment links", () => {
    for (const h of ["", "https://x.com/a", "HTTP://x", "mailto:a@b.c", "note://x", "#top"]) expect(resolveNoteHref(h, tabs)).toBeUndefined();
  });
  it("matches by normalised title", () => {
    expect(resolveNoteHref("project-plan.md", tabs)?.id).toBe("1");
    expect(resolveNoteHref("Project%20Plan", tabs)?.id).toBe("1");
  });
  it("matches by basename of a relative path", () => {
    expect(resolveNoteHref("sub/folder/ideas.md", tabs)?.id).toBe("2");
  });
  it("falls back to the tab file name", () => {
    expect(resolveNoteHref("../disk-file.md", tabs)?.id).toBe("3");
  });
  it("never targets settings/files tabs", () => {
    expect(resolveNoteHref("x", [tab("s", "x", { kind: "settings" }), tab("f", "x", { kind: "files" })])).toBeUndefined();
  });
});
