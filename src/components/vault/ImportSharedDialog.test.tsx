// @vitest-environment happy-dom
/**
 * Import shared items: file + password -> the short note -> Import. A share only goes into an open vault, the note
 * says what will happen, and a problem (ended file, no imports left, clock) stops the Import button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => "C:/Users/me/Downloads/friend.nqb"), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));
const refreshVaultUi = vi.fn(async () => {});
vi.mock("../../lib/syncSetupFlow", async (orig) => ({
  ...(await orig<typeof import("../../lib/syncSetupFlow")>()),
  refreshVaultUi: () => refreshVaultUi(),
}));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock("../../lib/toast", () => ({ toast }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ImportSharedDialog } = await import("./ImportSharedDialog");
type ShareInfo = import("../../lib/vaultShare").ShareInfo;

const INFO: ShareInfo = {
  notes: 2, folders: 1, attachments: 0, validUntil: null, itemLifeMs: 7 * 24 * 3_600_000, deleteFile: true,
  vault: "ready", importsLeft: 1, problem: null,
};
const RESULT = { added: 2, already: 0, expired: 0, importsLeft: 0, expiresAt: Date.now() + 7 * 86_400_000, fileDeleted: true, deleteFailed: false };

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  invoke.mockReset();
  refreshVaultUi.mockReset();
  onClose.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const render = async (initialPath = "C:/Users/me/Downloads/friend.nqb") => { await act(async () => { root.render(<ImportSharedDialog onClose={onClose} initialPath={initialPath} />); }); };
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const passwordInput = () => document.querySelector("input[type=password]") as HTMLInputElement;
async function typePassword(value: string) {
  await act(async () => {
    const input = passwordInput();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const open = async (info: ShareInfo = INFO) => {
  invoke.mockImplementation(async (cmd: string) => (cmd === "vault_share_inspect" ? info : cmd === "vault_share_import" ? RESULT : null));
  await render();
  await typePassword("a password for sharing");
  await act(async () => { button("Open")!.click(); });
};

describe("import shared items", () => {
  it("asks for the file's password and does nothing until it is typed", async () => {
    await render();
    expect(button("Open")!.disabled).toBe(true);
    await typePassword("x");
    expect(button("Open")!.disabled).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("opens the file with that password and shows what is in it with the short note", async () => {
    await open();
    expect(invoke).toHaveBeenCalledWith("vault_share_inspect", { path: "C:/Users/me/Downloads/friend.nqb", password: "a password for sharing" });
    const review = document.querySelector("[data-testid=share-review]")!;
    expect(review.textContent).toContain("2 notes, 1 folder");
    expect(review.textContent).toMatch(/removed from your vault on .+ \(in 7 days\)/);
    expect(review.textContent).toContain("can be imported 1 more time");
    expect(review.textContent).toContain("After this import, the file is deleted from this computer.");
    expect(button("Import")!.disabled).toBe(false);
  });

  it("imports, refreshes the vault, says what happened and closes", async () => {
    await open();
    await act(async () => { button("Import")!.click(); });
    expect(invoke).toHaveBeenCalledWith("vault_share_import", { path: "C:/Users/me/Downloads/friend.nqb", password: "a password for sharing" });
    expect(refreshVaultUi).toHaveBeenCalled();
    expect(toast.info.mock.calls[0][0]).toMatch(/^Imported 2 notes\./);
    expect(onClose).toHaveBeenCalled();
  });

  it("cancelling imports nothing", async () => {
    await open();
    await act(async () => { button("Cancel")!.click(); });
    expect(invoke.mock.calls.map((c) => c[0])).not.toContain("vault_share_import");
    expect(onClose).toHaveBeenCalled();
  });

  it("a wrong password shows the error and stays on the password step", async () => {
    invoke.mockRejectedValue("Wrong password");
    await render();
    await typePassword("nope nope nope");
    await act(async () => { button("Open")!.click(); });
    expect(document.querySelector("[role=alert]")!.textContent).toContain("Wrong password");
    expect(button("Open")).toBeTruthy();
    expect(document.querySelector("[data-testid=share-review]")).toBeNull();
  });

  it("with no vault yet it says to create one first and can't import", async () => {
    await open({ ...INFO, vault: "none", importsLeft: null });
    expect(document.querySelector("[role=alert]")!.textContent).toMatch(/Create your vault first/);
    expect(button("Import")!.disabled).toBe(true);
  });

  it("with the vault locked it offers to unlock and can't import yet", async () => {
    await open({ ...INFO, vault: "locked", importsLeft: null });
    expect(button("Unlock")).toBeTruthy();
    expect(button("Import")!.disabled).toBe(true);
  });

  it.each([
    ["expired", /expired/],
    ["noImportsLeft", /can't be imported again/],
    ["clockBehind", /date and time/],
  ] as const)("a file that is %s can't be imported", async (problem, text) => {
    await open({ ...INFO, problem, importsLeft: 0 });
    expect(document.querySelector("[role=alert]")!.textContent).toMatch(text);
    expect(button("Import")!.disabled).toBe(true);
    expect(document.querySelector("[data-testid=share-review] ul")).toBeNull();
  });

  it("when the file couldn't be deleted it says so, once", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "vault_share_inspect" ? INFO : { ...RESULT, fileDeleted: false, deleteFailed: true }));
    await render();
    await typePassword("a password for sharing");
    await act(async () => { button("Open")!.click(); });
    await act(async () => { button("Import")!.click(); });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0][0]).toMatch(/couldn't be deleted/);
  });

  it("an import that fails shows why and keeps the dialog open", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_share_inspect") return INFO;
      throw "This share file can't be imported again.";
    });
    await render();
    await typePassword("a password for sharing");
    await act(async () => { button("Open")!.click(); });
    await act(async () => { button("Import")!.click(); });
    expect(document.querySelector("[role=alert]")!.textContent).toContain("can't be imported again");
    expect(onClose).not.toHaveBeenCalled();
    expect(refreshVaultUi).not.toHaveBeenCalled();
  });
});
