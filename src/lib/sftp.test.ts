import { describe, it, expect } from "vitest";
import {
  imageMime, bytesFromBase64, decodeText,
  crumbs, joinRemote, modeOctal, modeString, nameProblem, parentRemote, parseOctalMode, percent, sortEntries, visibleEntries,
  type RemoteEntry,
} from "./sftp";

const e = (name: string, kind: RemoteEntry["kind"] = "file", size = 0, mtime: number | null = null): RemoteEntry =>
  ({ name, kind, link: false, size, mtime, mode: 0o644 });

describe("remote paths", () => {
  it("joins and goes up with slashes only", () => {
    expect(joinRemote("/var", "log")).toBe("/var/log");
    expect(joinRemote("/", "etc")).toBe("/etc");
    expect(parentRemote("/var/log/")).toBe("/var");
    expect(parentRemote("/var")).toBe("/");
    expect(parentRemote("/")).toBe("/");
  });
  it("makes a clickable path bar", () => {
    expect(crumbs("/var/log")).toEqual([
      { name: "/", path: "/" }, { name: "var", path: "/var" }, { name: "log", path: "/var/log" },
    ]);
    expect(crumbs("/")).toEqual([{ name: "/", path: "/" }]);
  });
  it("checks names for new files and folders", () => {
    expect(nameProblem("  ")).toBeTruthy();
    expect(nameProblem("..")).toBeTruthy();
    expect(nameProblem("a/b")).toBeTruthy();
    expect(nameProblem("notes.txt")).toBeNull();
  });
});

describe("listing", () => {
  const all = [e("b.txt", "file", 5, 10), e("zdir", "dir"), e("A.txt", "file", 9, 5), e(".env", "file", 1, 1)];
  it("keeps folders first in every sort", () => {
    for (const key of ["name", "size", "mtime"] as const) {
      for (const desc of [false, true]) {
        expect(sortEntries(all, { key, desc })[0].name).toBe("zdir");
      }
    }
  });
  it("sorts files by name, size and time, either way", () => {
    const names = (key: "name" | "size" | "mtime", desc: boolean) => sortEntries(all, { key, desc }).map((x) => x.name);
    expect(names("name", false)).toEqual(["zdir", ".env", "A.txt", "b.txt"]);
    expect(names("name", true)).toEqual(["zdir", "b.txt", "A.txt", ".env"]);
    expect(names("size", false)).toEqual(["zdir", ".env", "b.txt", "A.txt"]);
    expect(names("mtime", true)).toEqual(["zdir", "b.txt", "A.txt", ".env"]);
  });
  it("hides dot files unless asked, and filters by name", () => {
    expect(visibleEntries(all, "", false).map((x) => x.name)).not.toContain(".env");
    expect(visibleEntries(all, "", true).map((x) => x.name)).toContain(".env");
    expect(visibleEntries(all, "TXT", false).map((x) => x.name)).toEqual(["b.txt", "A.txt"]);
  });
});

describe("permissions", () => {
  it("shows bits both ways", () => {
    expect(modeString(0o755)).toBe("rwxr-xr-x");
    expect(modeString(0o640)).toBe("rw-r-----");
    expect(modeOctal(0o100644)).toBe("644");
    expect(modeString(null)).toBe("");
  });
  it("reads only octal digits", () => {
    expect(parseOctalMode("755")).toBe(0o755);
    expect(parseOctalMode("0644")).toBe(0o644);
    expect(parseOctalMode("789")).toBeNull();
    expect(parseOctalMode("rwx")).toBeNull();
  });
});

describe("progress", () => {
  it("is a whole percent, and an empty file is done", () => {
    expect(percent(50, 200)).toBe(25);
    expect(percent(5, 3)).toBe(100);
    expect(percent(0, 0)).toBe(100);
  });
});

describe("the viewer's helpers", () => {
  it("knows which files are pictures", () => {
    expect(imageMime("Photo.JPG")).toBe("image/jpeg");
    expect(imageMime("logo.svg")).toBe("image/svg+xml");
    expect(imageMime("notes.txt")).toBeNull();
    expect(imageMime("png")).toBeNull();
  });

  it("decodes base64 and tells text from binary", () => {
    const bytes = bytesFromBase64(btoa("héllo"));
    expect(bytes.length).toBe(5);
    expect(decodeText(new TextEncoder().encode("héllo ✓"))).toBe("héllo ✓");
    expect(decodeText(new Uint8Array([104, 0, 105]))).toBeNull();
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});
