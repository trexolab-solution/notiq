// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PropertiesDialog } = await import("./PropertiesDialog");

const props = (path: string, kind: "dir" | "file", extra: Record<string, unknown> = {}) => ({
  path, kind, link: false, target: null, size: kind === "dir" ? 4096 : 2048, mtime: 1_700_000_000, atime: 1_700_000_500,
  mode: kind === "dir" ? 0o755 : 0o644, uid: 1000, gid: 1000, user: "alice", group: null, ...extra,
});

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); invoke.mockReset(); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function show(items: { path: string }[], onPermissions?: () => void) {
  await act(async () => { root.render(<PropertiesDialog sid={1} items={items} onPermissions={onPermissions} onClose={() => {}} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("PropertiesDialog", () => {
  it("describes a single file without counting anything", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "sftp_props" ? [props("/home/alice/notes.txt", "file")] : undefined));
    await show([{ path: "/home/alice/notes.txt" }]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("notes.txt");
    expect(text).toContain("TXT file");
    expect(text).toContain("/home/alice");
    expect(text).toContain("2,048 bytes");
    expect(text).toContain("rw-r--r--");
    expect(text).toContain("alice (1000)");
    expect(invoke.mock.calls.some(([cmd]) => cmd === "sftp_tally")).toBe(false);
  });

  it("counts a folder's contents and shows the totals", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sftp_props") return [props("/srv/www", "dir")];
      if (cmd === "sftp_tally") return { files: 12, folders: 3, bytes: 1_500_000, unreadable: 1 };
      return undefined;
    });
    await show([{ path: "/srv/www" }]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("12 files, 3 folders");
    expect(text).toContain("1.4 MB");
    expect(text).toContain("1 place couldn't be read");
  });

  it("summarises several items, with their shared location", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sftp_props") return [props("/srv/a.txt", "file"), props("/srv/dir", "dir")];
      if (cmd === "sftp_tally") return { files: 5, folders: 2, bytes: 9000, unreadable: 0 };
      return undefined;
    });
    await show([{ path: "/srv/a.txt" }, { path: "/srv/dir" }]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("2 items");
    expect(text).toContain("1 file, 1 folder");
    expect(text).toContain("5 files, 2 folders");
    expect(text).not.toContain("Several locations");
  });

  it("shows where a link points and reports an error from the server", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "sftp_props" ? [props("/etc/current", "dir", { link: true, target: "/etc/v2" })] : { files: 0, folders: 0, bytes: 0, unreadable: 0 }));
    await show([{ path: "/etc/current" }]);
    expect(document.body.textContent).toContain("Symbolic link to a folder");
    expect(document.body.textContent).toContain("/etc/v2");
    act(() => root.unmount()); root = createRoot(host);
    invoke.mockImplementation(async () => { throw "That file or folder no longer exists on the server."; });
    await show([{ path: "/gone" }]);
    expect(document.body.textContent).toContain("no longer exists");
  });
});
