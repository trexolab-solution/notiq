// @vitest-environment happy-dom
/**
 * Share items: tick what to share, a password for the receiver (made for you), the rules, your master password, then
 * the file is saved and you are told to send the password separately.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: vi.fn(), emitTo: vi.fn() }));
const save = vi.fn(async (_o?: unknown): Promise<string | null> => "C:/Users/me/Desktop/notiq-share.nqb");
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: (o?: unknown) => save(o) }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn() }));
const reveal = vi.fn(async (_p: string) => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: (p: string) => reveal(p), openUrl: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ShareItemsDialog } = await import("./ShareItemsDialog");

const item = (rel: string) => ({ rel, ext: rel.endsWith(".nqv") ? "md" : "", updated: 0, dir: !rel.endsWith(".nqv"), tags: [], starred: false, trashed_at: null, attachments: 0, history: 0 });
const LIST = [item("Work"), item("Work/bank.nqv"), item("Work/mail.nqv"), item("top.nqv")];
const PREVIEW = { notes: 1, folders: 1, attachments: 0, attachmentBytes: 0, contentBytes: 10 };

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  invoke.mockReset(); save.mockClear(); reveal.mockReset(); onClose.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "vault_list") return LIST;
    if (cmd === "vault_share_preview") return PREVIEW;
    if (cmd === "vault_share_export") return { bytes: 2048, notes: 1 };
    return null;
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const render = async (paths: string[] = ["Work/bank.nqv"]) => { await act(async () => { root.render(<ShareItemsDialog onClose={onClose} initialPaths={paths} />); }); };
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;
const box = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const master = () => document.querySelector("input[aria-label='Master password']") as HTMLInputElement;
const calls = (name: string) => invoke.mock.calls.filter((c) => c[0] === name);

describe("share items dialog", () => {
  it("lists the vault with what was asked for ticked, shows what it holds and a made password", async () => {
    await render();
    expect(box("Work/bank.nqv").checked).toBe(true);
    expect(box("Work/mail.nqv").checked).toBe(false);
    expect(calls("vault_share_preview")[0][1]).toEqual({ paths: ["Work/bank.nqv"], attachments: false });
    expect(document.querySelector("[data-testid=share-preview]")!.textContent).toContain("1 note, 1 folder");
    expect((box("Share password")).value).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
  });

  it("can't be saved until the master password is typed", async () => {
    await render();
    expect(button("Save share file")!.disabled).toBe(true);
    await type(master(), "the master password");
    expect(button("Save share file")!.disabled).toBe(false);
  });

  it("ticking a folder covers what is under it", async () => {
    await render();
    await act(async () => { box("Work").click(); });
    expect(box("Work").checked).toBe(true);
    expect(box("Work/bank.nqv").checked).toBe(true);
    expect(box("Work/bank.nqv").disabled).toBe(true);
    expect(calls("vault_share_preview").at(-1)![1]).toEqual({ paths: ["Work"], attachments: false });
  });

  it("including attachments asks for the size again", async () => {
    await render();
    const label = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.includes("Include attachments"))!;
    await act(async () => { (label.querySelector("input") as HTMLInputElement).click(); });
    expect(calls("vault_share_preview").at(-1)![1]).toEqual({ paths: ["Work/bank.nqv"], attachments: true });
  });

  it("a selection that can't be shared says why and blocks saving", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_list") return LIST;
      if (cmd === "vault_share_preview") throw "1 of the chosen note came from a share and can't be shared again.";
      return null;
    });
    await render();
    await type(master(), "the master password");
    expect(document.querySelector("[data-testid=share-preview] [role=alert]")!.textContent).toMatch(/came from a share/);
    expect(button("Save share file")!.disabled).toBe(true);
  });

  it("saves the file with every choice, then says to send the password separately", async () => {
    await render();
    await type(master(), "the master password");
    await type(box("Imports allowed"), "3");
    const password = box("Share password").value;
    await act(async () => { button("Save share file")!.click(); });
    expect(save).toHaveBeenCalledTimes(1);
    const args = (calls("vault_share_export")[0][1] as { args: Record<string, unknown> }).args;
    expect(args).toMatchObject({
      paths: ["Work/bank.nqv"], attachments: false, masterPassword: "the master password", sharePassword: password, maxImports: 3,
      itemLifeHours: 168, deleteFile: true, destPath: "C:/Users/me/Desktop/notiq-share.nqb",
    });
    expect(typeof args.validUntilMs).toBe("number");
    const done = document.querySelector("[data-testid=share-done]")!;
    expect(done.textContent).toContain(password);
    expect(done.textContent).toMatch(/Send the password separately/);
    await act(async () => { button("Show in folder")!.click(); });
    expect(reveal).toHaveBeenCalledWith("C:/Users/me/Desktop/notiq-share.nqb");
    await act(async () => { button("Done")!.click(); });
    expect(onClose).toHaveBeenCalled();
  });

  it("cancelling the save dialog writes nothing and keeps the form", async () => {
    save.mockResolvedValueOnce(null);
    await render();
    await type(master(), "the master password");
    await act(async () => { button("Save share file")!.click(); });
    expect(calls("vault_share_export")).toHaveLength(0);
    expect(document.querySelector("[data-testid=share-done]")).toBeNull();
    expect(button("Save share file")).toBeTruthy();
  });

  it("a wrong master password shows the error and does not finish", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_list") return LIST;
      if (cmd === "vault_share_preview") return PREVIEW;
      throw "Wrong password";
    });
    await render();
    await type(master(), "not it not it");
    await act(async () => { button("Save share file")!.click(); });
    expect(document.querySelector("[role=alert]")!.textContent).toContain("Wrong password");
    expect(document.querySelector("[data-testid=share-done]")).toBeNull();
  });

  it("the same password as the master password is refused before anything is written", async () => {
    await render();
    const pw = box("Share password").value;
    await type(master(), pw);
    expect(button("Save share file")!.disabled).toBe(true);
    expect(document.querySelector("[data-testid=share-problem]")!.textContent).toMatch(/different password/);
  });
});
