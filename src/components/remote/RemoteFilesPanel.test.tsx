// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn();
const pickSave = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => null), save: (...a: unknown[]) => pickSave(...a) }));
vi.mock("../../lib/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock("@monaco-editor/react", () => ({
  default: (p: { value: string; onChange: (v: string) => void }) => (
    <textarea data-testid="editor" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn(async () => {}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RemoteFilesPanel } = await import("./RemoteFilesPanel");
const { toast } = await import("../../lib/toast");

const entry = (name: string, kind: "dir" | "file", size = 0) => ({ name, kind, link: false, size, mtime: 1_700_000_000, mode: 0o644 });
const TREE: Record<string, ReturnType<typeof entry>[]> = {
  "/home/alice": [entry("notes.txt", "file", 2048), entry("projects", "dir"), entry(".bashrc", "file", 10)],
  "/home/alice/projects": [entry("app.log", "file", 5)],
};

let host: HTMLDivElement;
let root: Root;
const target = { path: "C:/v/web.nqv", auth: "password" as const, title: "web" };

function fakeServer() {
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    switch (cmd) {
      case "sftp_open": return { title: "Web server", home: "/home/alice" };
      case "sftp_list": {
        const path = args.path as string;
        if (!(path in TREE)) throw "That file or folder doesn't exist.";
        return { path, entries: TREE[path] };
      }
      case "sftp_download": return 2048;
      case "sftp_read": return { data: btoa("hello"), mtime: 1_700_000_000 };
      case "sftp_write": return 1_700_000_001;
      case "sftp_remove": return undefined;
      default: return undefined;
    }
  });
}

async function show() {
  await act(async () => { root.render(<RemoteFilesPanel target={target} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

const rows = () => [...document.querySelectorAll<HTMLElement>("[data-remote-rows] [role=row]")];
const names = () => rows().map((r) => r.dataset.name);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim().startsWith(label) || b.getAttribute("aria-label") === label)!;

beforeEach(() => {
  invoke.mockReset(); pickSave.mockReset(); vi.mocked(toast.error).mockReset();
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("RemoteFilesPanel", () => {
  it("signs in with the saved entry and lists the home folder, folders first, dot files hidden", async () => {
    fakeServer();
    await show();
    expect(invoke).toHaveBeenCalledWith("sftp_open", expect.objectContaining({ path: "C:/v/web.nqv", auth: "password" }));
    expect(names()).toEqual(["projects", "notes.txt"]);
    expect(document.querySelector("[data-testid=remote-files]")!.getAttribute("aria-label")).toBe("Files on Web server");
    await click(button("Show dot files"));
    expect(names()).toEqual(["projects", ".bashrc", "notes.txt"]);
  });

  it("opens a folder on double-click and goes back up", async () => {
    fakeServer();
    await show();
    await act(async () => { rows()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(invoke).toHaveBeenCalledWith("sftp_list", expect.objectContaining({ path: "/home/alice/projects" }));
    expect(names()).toEqual(["app.log"]);
    await click(button("Up one folder"));
    expect(names()).toEqual(["projects", "notes.txt"]);
  });

  it("downloads the selected file to the chosen place and shows it as done", async () => {
    fakeServer();
    pickSave.mockResolvedValue("C:/Users/me/notes.txt");
    await show();
    await click(rows()[1]); // notes.txt
    await click(button("Download"));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoke).toHaveBeenCalledWith("sftp_download", expect.objectContaining({
      remote: "/home/alice/notes.txt", local: "C:/Users/me/notes.txt", overwrite: false,
    }));
    expect(document.querySelector("[aria-label=Transfers]")!.textContent).toContain("Done");
  });

  it("asks before deleting and then removes the file on the server", async () => {
    fakeServer();
    await show();
    await click(rows()[1]);
    await click(button("Delete"));
    expect(invoke).not.toHaveBeenCalledWith("sftp_remove", expect.anything());
    expect(document.body.textContent).toContain("Delete notes.txt?");
    await click([...document.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === "Delete").pop()!);
    expect(invoke).toHaveBeenCalledWith("sftp_remove", expect.objectContaining({ path: "/home/alice/notes.txt" }));
  });

  it("explains a failed connection and can try again", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sftp_open") throw "This server isn't a trusted host yet. Open it in the terminal once.";
      return undefined;
    });
    await show();
    expect(document.body.textContent).toContain("isn't a trusted host yet");
    expect(button("Try again")).toBeTruthy();
    fakeServer();
    await click(button("Try again"));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(names()).toEqual(["projects", "notes.txt"]);
  });

  it("closes the connection when the panel goes away", async () => {
    fakeServer();
    await show();
    await act(async () => root.unmount());
    expect(invoke).toHaveBeenCalledWith("sftp_close", expect.anything());
    root = createRoot(host); // so afterEach can unmount
  });

  it("right-click selects the row and offers the file actions", async () => {
    fakeServer();
    await show();
    await act(async () => { rows()[1].dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
    const labels = [...document.querySelectorAll("[role=menu] button, [role=menuitem]")].map((b) => b.textContent?.trim());
    for (const want of ["Open / edit", "Download…", "Rename…", "Copy path", "Delete…"]) {
      expect(labels.some((l) => l?.startsWith(want))).toBe(true);
    }
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
  });

  it("opens a text file in the editor and saves the change back with the modified time it was opened with", async () => {
    fakeServer();
    await show();
    await act(async () => { rows()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(invoke).toHaveBeenCalledWith("sftp_read", expect.objectContaining({ path: "/home/alice/notes.txt" }));
    const ed = document.querySelector<HTMLTextAreaElement>("[data-testid=editor]")!;
    expect(ed.value).toBe("hello");
    expect(button("Save").disabled).toBe(true);
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => { set.call(ed, "hello world"); ed.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(button("Save").disabled).toBe(false);
    await click(button("Save"));
    expect(invoke).toHaveBeenCalledWith("sftp_write", expect.objectContaining({ path: "/home/alice/notes.txt", text: "hello world", expect: 1_700_000_000, force: false }));
  });

  it("goes back and forward through the folders visited", async () => {
    fakeServer();
    await show();
    expect(button("Back").disabled).toBe(true);
    await act(async () => { rows()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(names()).toEqual(["app.log"]);
    expect(button("Back").disabled).toBe(false);
    await click(button("Back"));
    expect(names()).toEqual(["projects", "notes.txt"]);
    expect(button("Forward").disabled).toBe(false);
    await click(button("Forward"));
    expect(names()).toEqual(["app.log"]);
  });

  it("cuts an item and pastes it into another folder (a move)", async () => {
    fakeServer();
    await show();
    await click(rows()[1]);                       // notes.txt
    await click(button("Cut"));
    expect(button("Paste").disabled).toBe(true);  // same folder: nothing to move
    await act(async () => { rows()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
    expect(button("Paste").disabled).toBe(false);
    await click(button("Paste"));
    expect(invoke).toHaveBeenCalledWith("sftp_rename", expect.objectContaining({ id: expect.any(Number), from: "/home/alice/notes.txt", to: "/home/alice/projects/notes.txt" }));
  });

  it("changes permissions from the grid and applies the octal number", async () => {
    fakeServer();
    await show();
    await click(rows()[1]);
    await click(button("Permissions"));
    const octal = document.querySelector<HTMLInputElement>("#remote-octal")!;
    expect(octal.value).toBe("644");
    const box = document.querySelector<HTMLInputElement>("input[aria-label='Others write']")!;
    await click(box);
    expect(octal.value).toBe("646");
    await click([...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Apply")!);
    expect(invoke).toHaveBeenCalledWith("sftp_chmod", expect.objectContaining({ path: "/home/alice/notes.txt", mode: 0o646 }));
  });

  it("follows the file manager settings: hidden files, sort order, double-click download, no delete prompt", async () => {
    localStorage.setItem("pref:filesPrefs", JSON.stringify({ showHidden: true, sortKey: "size", sortDesc: true, openAction: "download", confirmDelete: false }));
    try {
      fakeServer();
      await show();
      expect(names()).toEqual(["projects", "notes.txt", ".bashrc"]);   // dot files shown, files by size, largest first
      pickSave.mockResolvedValue("C:/out/notes.txt");
      await act(async () => { rows()[1].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
      expect(invoke).toHaveBeenCalledWith("sftp_download", expect.objectContaining({ remote: "/home/alice/notes.txt" }));
      expect(invoke).not.toHaveBeenCalledWith("sftp_read", expect.anything());
      await click(rows()[1]);
      await click(button("Delete"));
      expect(invoke).toHaveBeenCalledWith("sftp_remove", expect.objectContaining({ path: "/home/alice/notes.txt" }));
    } finally { localStorage.removeItem("pref:filesPrefs"); }
  });
});
