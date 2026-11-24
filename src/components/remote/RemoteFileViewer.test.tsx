// @vitest-environment happy-dom
/**
 * The remote file viewer: a Markdown file opens as a page (Edit / Preview), a CSV or TSV file as a table (Text / Table),
 * any other text only in the editor. The preview follows what is typed, saved or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_c: string, _a?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (c: string, a?: unknown) => invoke(c, a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
// Monaco is not run in tests: a plain textarea stands in for the editor.
vi.mock("@monaco-editor/react", () => ({
  default: ({ value, onChange, language }: { value: string; onChange: (v: string) => void; language: string }) => (
    <textarea data-testid="editor" data-language={language} value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock("../../lib/toast", () => ({ toast }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RemoteFileViewer } = await import("./RemoteFileViewer");

const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));
const files: Record<string, string> = {
  "/home/me/README.md": "# Hello\n\nSome **bold** text.\n",
  "/home/me/data.csv": "name,qty\nbolt,10\nnut,9\n",
  "/home/me/data.tsv": "a\tb\n1\t2\n",
  "/home/me/notes.txt": "plain text\n",
};

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => Array.from(document.querySelectorAll("button, [role=radio]")).find((b) => b.textContent?.trim() === label) as HTMLElement | undefined;
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const q = (sel: string) => document.querySelector(sel);

async function open(path: string) {
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    if (cmd === "sftp_read") return { data: b64(files[(args as { path: string }).path]), mtime: 1, size: 10 };
    if (cmd === "sftp_write") return 2;
    return null;
  });
  await act(async () => { root.render(<RemoteFileViewer session={1} path={path} name={path.split("/").pop()!} onClose={onClose} onDownload={() => {}} onSaved={() => {}} />); });
  await flush(); await flush();
}

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); invoke.mockReset(); onClose.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ""; });

describe("RemoteFileViewer", () => {
  it("a Markdown file opens as a page, with Edit and Preview", async () => {
    await open("/home/me/README.md");
    expect(q("[data-testid=markdown-view] h1")!.textContent).toBe("Hello");
    expect(q("[data-testid=editor]")).toBeNull();
    expect(q('[role=radiogroup][aria-label="Markdown view"]')).toBeTruthy();
    expect(button("Preview")!.getAttribute("aria-checked")).toBe("true");
  });

  it("Edit shows the editor with the text, and Preview goes back", async () => {
    await open("/home/me/README.md");
    await click(button("Edit"));
    expect((q("[data-testid=editor]") as HTMLTextAreaElement).value).toBe("# Hello\n\nSome **bold** text.\n");
    expect(q("[data-testid=markdown-view]")).toBeNull();
    await click(button("Preview"));
    expect(q("[data-testid=markdown-view]")).toBeTruthy();
  });

  it("the preview shows what was typed, before it is saved", async () => {
    await open("/home/me/README.md");
    await click(button("Edit"));
    await act(async () => {
      const t = q("[data-testid=editor]") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(t, "# Changed title\n");
      t.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Unsaved changes");
    await click(button("Preview"));
    expect(q("[data-testid=markdown-view] h1")!.textContent).toBe("Changed title");
    expect(document.body.textContent).toContain("Unsaved changes");
  });

  it("a CSV file opens as a table, with Text and Table", async () => {
    await open("/home/me/data.csv");
    expect(q("table")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("thead th")).slice(1).map((t) => t.textContent)).toEqual(["name", "qty"]);
    expect(q('[role=radiogroup][aria-label="CSV view"]')).toBeTruthy();
    expect(button("Table")!.getAttribute("aria-checked")).toBe("true");
    await click(button("Text"));
    expect((q("[data-testid=editor]") as HTMLTextAreaElement).value).toBe("name,qty\nbolt,10\nnut,9\n");
    expect(q("table")).toBeNull();
  });

  it("a TSV file opens as a table too", async () => {
    await open("/home/me/data.tsv");
    expect(Array.from(document.querySelectorAll("thead th")).slice(1).map((t) => t.textContent)).toEqual(["a", "b"]);
  });

  it("any other text opens in the editor alone, with no switch", async () => {
    await open("/home/me/notes.txt");
    expect((q("[data-testid=editor]") as HTMLTextAreaElement).value).toBe("plain text\n");
    expect(q("[role=radiogroup]")).toBeNull();
    expect(q("[data-testid=markdown-view]")).toBeNull();
    expect(q("table")).toBeNull();
  });

  it("saving from the preview still works (Ctrl+S)", async () => {
    await open("/home/me/README.md");
    await click(button("Edit"));
    await act(async () => {
      const t = q("[data-testid=editor]") as HTMLTextAreaElement;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(t, "# New\n");
      t.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(button("Preview"));
    await act(async () => { (q("[role=region]") as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })); });
    await flush();
    expect(invoke).toHaveBeenCalledWith("sftp_write", expect.objectContaining({ path: "/home/me/README.md", text: "# New\n" }));
  });
});
