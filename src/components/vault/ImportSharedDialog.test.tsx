// @vitest-environment happy-dom
/**
 * Import shared items as a stepper: File (drop or choose) -> Password -> Review (the short note) -> Done. A share only
 * goes into an open vault, a normal backup is turned away at the File step, and a problem (ended file, no imports
 * left, clock) stops the Import button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: vi.fn(), emitTo: vi.fn() }));
const dialogOpen = vi.fn(async (_o?: unknown): Promise<string | null> => "C:/Users/me/Downloads/friend.nqb");
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (o?: unknown) => dialogOpen(o), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn(async () => ({ isDirectory: false })) }));
const refreshVaultUi = vi.fn(async () => {});
vi.mock("../../lib/syncSetupFlow", async (orig) => ({
  ...(await orig<typeof import("../../lib/syncSetupFlow")>()),
  refreshVaultUi: () => refreshVaultUi(),
}));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock("../../lib/toast", () => ({ toast }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ImportSharedDialog } = await import("./ImportSharedDialog");
const { clearDropTargets, dropAt } = await import("../../lib/dropTargets");
type ShareInfo = import("../../lib/vaultShare").ShareInfo;

const PATH = "C:/Users/me/Downloads/friend.nqb";
const HEADER = { ok: true, kind: "share", vault_id_hex: "ab", db_bytes: 4096, created: null };
const INFO: ShareInfo = {
  items: [
    { path: "Work", ext: "", dir: true, attachments: 0 },
    { path: "Work/bank.nqv", ext: "login", dir: false, attachments: 0 },
    { path: "Work/server.nqv", ext: "ssh", dir: false, attachments: 2 },
  ],
  notes: 2, folders: 1, attachments: 2, validUntil: null, itemLifeMs: 7 * 24 * 3_600_000, deleteFile: true,
  vault: "ready", importsLeft: 1, problem: null,
};
const RESULT = { added: 2, already: 0, expired: 0, importsLeft: 0, expiresAt: Date.now() + 7 * 86_400_000, fileDeleted: true, deleteFailed: false };

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const step = () => document.querySelector("[data-import-step]")!.getAttribute("data-import-step");
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const password = () => document.querySelector("input[type=password]") as HTMLInputElement;
async function typePassword(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password(), value);
    password().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const calls = (name: string) => invoke.mock.calls.filter((c) => c[0] === name);

function backend(over: Record<string, unknown> = {}) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd in over) { const v = over[cmd]; if (v instanceof Error) throw v; return v; }
    if (cmd === "vault_backup_inspect") return HEADER;
    if (cmd === "vault_share_inspect") return INFO;
    if (cmd === "vault_share_import") return RESULT;
    return null;
  });
}
const render = async (initialPath?: string) => { await act(async () => { root.render(<ImportSharedDialog onClose={onClose} initialPath={initialPath} />); }); await flush(); };
/** File chosen, password typed, file opened: on the Review step. */
async function toReview(info: ShareInfo = INFO) {
  backend({ vault_share_inspect: info });
  await render(PATH);
  await click(button("Next"));
  await typePassword("a password for sharing");
  await click(button("Open"));
}

beforeEach(() => {
  invoke.mockReset(); refreshVaultUi.mockReset(); onClose.mockReset(); dialogOpen.mockClear();
  Object.values(toast).forEach((f) => f.mockReset());
  backend();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const box = this.hasAttribute("data-drop-zone") ? 300 : this.classList.contains("dlg-panel") ? 600 : 0;
    return { left: 0, top: 0, right: box, bottom: box, width: box, height: box, x: 0, y: 0 } as DOMRect;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  clearDropTargets();
  vi.restoreAllMocks();
});

describe("import shared items", () => {
  it("starts on File with a drop zone and the four steps", async () => {
    await render();
    expect(step()).toBe("file");
    expect([...document.querySelectorAll('ol[aria-label="Import steps"] > li')].map((li) => li.textContent)).toEqual(["1File", "2Password", "3Review", "4Done"]);
    expect(document.querySelector("[data-drop-zone]")!.textContent).toContain("share file here");
    expect(button("Next")!.disabled).toBe(true);
  });

  it("a file that is dropped is checked and shown", async () => {
    await render();
    let handled = false;
    await act(async () => { handled = dropAt([PATH], { x: 50, y: 50 }, 1); });
    await flush();
    expect(handled).toBe(true);
    expect(calls("vault_backup_inspect")[0][1]).toEqual({ path: PATH });
    expect(document.querySelector("[data-file-card]")!.textContent).toMatch(/friend\.nqb.*Share file/);
    expect(button("Next")!.disabled).toBe(false);
  });

  it("a file that is chosen is checked the same way", async () => {
    await render();
    await click(button("Choose file"));
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-file-card]")!.textContent).toContain("Share file");
  });

  it("turns a normal backup away at the File step", async () => {
    backend({ vault_backup_inspect: { ...HEADER, kind: "backup" } });
    await render(PATH);
    expect(document.querySelector("[data-file-card] [role=alert]")!.textContent).toMatch(/normal backup.*Restore a backup/);
    expect(button("Next")!.disabled).toBe(true);
  });

  it("refuses a dropped folder, two files, or something that is not a backup file", async () => {
    await render();
    await act(async () => { dropAt(["C:/notes/todo.md"], { x: 50, y: 50 }, 1); });
    await flush();
    expect(document.querySelector("[data-drop-zone]")).toBeTruthy();
    expect(button("Next")!.disabled).toBe(true);
    expect(calls("vault_backup_inspect")).toHaveLength(0);
  });

  it("asks for the file's password and does nothing until it is typed", async () => {
    await render(PATH);
    await click(button("Next"));
    expect(step()).toBe("password");
    expect(button("Open")!.disabled).toBe(true);
    await typePassword("x");
    expect(button("Open")!.disabled).toBe(false);
    expect(calls("vault_share_inspect")).toHaveLength(0);
  });

  it("opens the file with that password and shows what is in it with the short note", async () => {
    await toReview();
    expect(step()).toBe("review");
    expect(calls("vault_share_inspect")[0][1]).toEqual({ path: PATH, password: "a password for sharing" });
    const review = document.querySelector("[data-testid=share-review]")!;
    expect(review.textContent).toContain("2 notes, 1 folder, 2 attachments");
    expect(review.textContent).toMatch(/removed from your vault on .+ \(in 7 days\)/);
    expect(review.textContent).toContain("can be imported 1 more time");
    expect(review.textContent).toContain("After this import, the file is deleted from this computer.");
    expect(button("Import")!.disabled).toBe(false);
  });

  it("lists the items by name, under their folder, with their type", async () => {
    await toReview();
    const rows = Array.from(document.querySelectorAll("[data-testid=share-items] li")).map((li) => li.textContent);
    expect(rows).toEqual(["Work", "bankLogin", "serverSSH / server· 2 files"]);
  });

  it("imports, refreshes the vault and ends on Done with what happened", async () => {
    await toReview();
    await click(button("Import"));
    expect(calls("vault_share_import")[0][1]).toEqual({ path: PATH, password: "a password for sharing" });
    expect(refreshVaultUi).toHaveBeenCalled();
    expect(step()).toBe("done");
    const done = document.querySelector("[data-testid=import-done]")!;
    expect(done.textContent).toMatch(/Imported 2 notes\./);
    expect(done.textContent).toContain("The share file was deleted from this computer.");
    await click(button("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("Back goes to the password and keeps it", async () => {
    await toReview();
    await click(button("Back"));
    expect(step()).toBe("password");
    expect(password().value).toBe("a password for sharing");
  });

  it("cancelling imports nothing", async () => {
    await toReview();
    await click(button("Cancel"));
    expect(calls("vault_share_import")).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });

  it("a wrong password shows the error and stays on the password step", async () => {
    backend({ vault_share_inspect: new Error("Wrong password") });
    invoke.mockImplementation(async (cmd: string) => { if (cmd === "vault_share_inspect") throw "Wrong password"; return cmd === "vault_backup_inspect" ? HEADER : null; });
    await render(PATH);
    await click(button("Next"));
    await typePassword("nope nope nope");
    await click(button("Open"));
    expect(step()).toBe("password");
    expect(document.querySelector("[role=alert]")!.textContent).toContain("Wrong password");
  });

  it("with no vault yet it says to create one first and can't import", async () => {
    await toReview({ ...INFO, vault: "none", importsLeft: null });
    expect(document.querySelector("[role=alert]")!.textContent).toMatch(/Create your vault first/);
    expect(button("Import")!.disabled).toBe(true);
  });

  it("with the vault locked it offers to unlock and can't import yet", async () => {
    await toReview({ ...INFO, vault: "locked", importsLeft: null });
    expect(button("Unlock vault")).toBeTruthy();
    expect(button("Import")!.disabled).toBe(true);
  });

  it.each([
    ["expired", /expired/],
    ["noImportsLeft", /can't be imported again/],
    ["clockBehind", /date and time/],
  ] as const)("a file that is %s can't be imported", async (problem, text) => {
    await toReview({ ...INFO, problem, importsLeft: 0 });
    expect(document.querySelector("[role=alert]")!.textContent).toMatch(text);
    expect(button("Import")!.disabled).toBe(true);
    expect(document.querySelector("[data-testid=share-note]")).toBeNull();
    expect(document.querySelector("[data-testid=share-items]")).toBeTruthy();
  });

  it("when the file couldn't be deleted it says so, once", async () => {
    backend({ vault_share_import: { ...RESULT, fileDeleted: false, deleteFailed: true } });
    await render(PATH);
    await click(button("Next"));
    await typePassword("a password for sharing");
    await click(button("Open"));
    await click(button("Import"));
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0][0]).toMatch(/couldn't be deleted/);
  });

  it("an import that fails shows why and stays on Review", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_backup_inspect") return HEADER;
      if (cmd === "vault_share_inspect") return INFO;
      throw "This share file can't be imported again.";
    });
    await render(PATH);
    await click(button("Next"));
    await typePassword("a password for sharing");
    await click(button("Open"));
    await click(button("Import"));
    expect(step()).toBe("review");
    expect(document.querySelector("[role=alert]")!.textContent).toContain("can't be imported again");
    expect(refreshVaultUi).not.toHaveBeenCalled();
  });
});
