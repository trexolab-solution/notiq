import { describe, it, expect } from "vitest";
import {
  getFileName,
  getFileStem,
  getFileExtension,
  dirname,
  joinPath,
  isAbsolute,
} from "./pathUtils";

describe("getFileName", () => {
  it("handles forward slashes", () => {
    expect(getFileName("a/b/c.txt")).toBe("c.txt");
  });
  it("handles Windows backslashes", () => {
    expect(getFileName("notes\\sub\\foo.md")).toBe("foo.md");
  });
  it("returns the input when there is no separator", () => {
    expect(getFileName("foo.md")).toBe("foo.md");
  });
});

describe("getFileStem", () => {
  it("strips the extension", () => {
    expect(getFileStem("notes/foo.md")).toBe("foo");
  });
  it("returns the name unchanged when there is no extension", () => {
    expect(getFileStem("README")).toBe("README");
  });
  it("keeps a leading-dot dotfile intact", () => {
    expect(getFileStem(".env")).toBe(".env");
  });
});

describe("getFileExtension", () => {
  it("lowercases the extension", () => {
    expect(getFileExtension("foo.MD")).toBe("md");
  });
  it("returns empty string when there is no extension", () => {
    expect(getFileExtension("noext")).toBe("");
  });
});

describe("dirname", () => {
  it("returns the parent directory", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
  });
  it("returns empty string for a bare filename", () => {
    expect(dirname("file.md")).toBe("");
  });
  it("normalizes backslashes", () => {
    expect(dirname("a\\b\\c.md")).toBe("a/b");
  });
});

describe("joinPath", () => {
  it("collapses repeated separators", () => {
    expect(joinPath("a/", "/b/", "c")).toBe("a/b/c");
  });
  it("joins simple segments", () => {
    expect(joinPath("a", "b")).toBe("a/b");
  });
});

describe("isAbsolute", () => {
  it("recognizes POSIX absolute paths", () => {
    expect(isAbsolute("/usr/local")).toBe(true);
  });
  it("recognizes Windows drive paths (both separators)", () => {
    expect(isAbsolute("C:/Users")).toBe(true);
    expect(isAbsolute("C:\\Users")).toBe(true);
  });
  it("rejects relative paths and empty input", () => {
    expect(isAbsolute("rel/path")).toBe(false);
    expect(isAbsolute("")).toBe(false);
  });
});
