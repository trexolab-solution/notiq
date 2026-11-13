import { describe, expect, it } from "vitest";
import { vi } from "vitest";

vi.mock("@tauri-apps/api/webviewWindow", () => ({ WebviewWindow: class {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const { filesWindowLabel, filesWindowUrl, parseFilesHash } = await import("./remoteFilesWindow");

const t = { path: "C:/Users/me/Vault/web & db.nqv", auth: "password" as const, title: "web server #1" };

describe("file manager window", () => {
  it("gives one label per server and sign-in, usable as a window label", () => {
    expect(filesWindowLabel(t)).toBe(filesWindowLabel({ ...t, title: "renamed" }));
    expect(filesWindowLabel(t)).not.toBe(filesWindowLabel({ ...t, auth: "key" }));
    expect(filesWindowLabel(t)).not.toBe(filesWindowLabel({ ...t, path: "C:/other.nqv" }));
    expect(filesWindowLabel(t)).toMatch(/^remote-files-[0-9a-f]+$/);
  });

  it("carries the target through the page address and back, whatever characters it has", () => {
    const url = filesWindowUrl(t);
    expect(url.startsWith("index.html#/remote-files?")).toBe(true);
    expect(parseFilesHash(url.slice(url.indexOf("#")))).toEqual(t);
  });

  it("refuses an address that doesn't name a server", () => {
    expect(parseFilesHash("#/sticky-note/1")).toBeNull();
    expect(parseFilesHash("#/remote-files")).toBeNull();
    expect(parseFilesHash("#/remote-files?path=C:/a.nqv&auth=root")).toBeNull();
    expect(parseFilesHash("#/remote-files?auth=key")).toBeNull();
    expect(parseFilesHash("#/remote-files?path=C:/a.nqv&auth=key")).toEqual({ path: "C:/a.nqv", auth: "key", title: "server" });
  });
});
