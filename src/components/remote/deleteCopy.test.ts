// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));

const { deleteTitle, deleteMessage } = await import("./RemoteFilesPanel");
const e = (name: string, kind: "dir" | "file") => ({ name, kind, link: false, size: 0, mtime: null, mode: null });

describe("delete prompt copy", () => {
  it("names what is deleted", () => {
    expect(deleteTitle([e("test", "dir")])).toBe("Delete folder \u201ctest\u201d?");
    expect(deleteTitle([e("a.txt", "file")])).toBe("Delete file \u201ca.txt\u201d?");
    expect(deleteTitle([e("a", "file"), e("b", "dir")])).toBe("Delete 2 items?");
  });

  it("says it is permanent, and that a folder takes its contents along", () => {
    expect(deleteMessage([e("test", "dir")], "Trexolab VPS")).toBe("The folder and everything inside it will be permanently deleted from Trexolab VPS. This can't be undone.");
    expect(deleteMessage([e("a.txt", "file")], "web")).toBe("The file will be permanently deleted from web. This can't be undone.");
    expect(deleteMessage([e("a", "file"), e("b", "dir")], "web")).toContain("including everything inside the folders");
    expect(deleteMessage([e("a", "file"), e("b", "file")], "web")).toContain("These files will be permanently deleted from web");
  });
});
