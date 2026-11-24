// @vitest-environment happy-dom
/**
 * Share items as a stepper: Items -> Rules -> Confirm -> Done. Tick what to share, the receiver's password and the rules
 * (how often, how long the file works, how long the items stay, in hours or days), then a summary and the master
 * password; the file is saved and the sender is told to send the password separately.
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
const field = (label: string) => document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const step = () => document.querySelector("[data-share-step]")!.getAttribute("data-share-step");
const calls = (name: string) => invoke.mock.calls.filter((c) => c[0] === name);
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Opens the custom dropdown labelled `label` and picks the option with `text`. */
async function pick(label: string, text: string) {
  await act(async () => { (document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click(); });
  const option = Array.from(document.querySelectorAll("[role=option]")).find((o) => o.textContent === text) as HTMLElement;
  await act(async () => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
}
const next = async () => { await act(async () => { button("Next")!.click(); }); };
const toConfirm = async () => { await next(); await next(); };

describe("share items stepper", () => {
  it("starts on Items with what was asked for ticked, what it holds, and four steps shown", async () => {
    await render();
    expect(step()).toBe("items");
    expect(Array.from(document.querySelectorAll("[data-stepper] li")).map((li) => li.textContent?.replace("(completed)", "").trim().replace(/^\d/, "").trim())).toEqual(["Items", "Rules", "Confirm", "Done"]);
    expect(field("Work/bank.nqv").checked).toBe(true);
    expect(field("Work/mail.nqv").checked).toBe(false);
    expect(calls("vault_share_preview")[0][1]).toEqual({ paths: ["Work/bank.nqv"], attachments: false });
    expect(document.querySelector("[data-testid=share-preview]")!.textContent).toContain("1 note, 1 folder");
  });

  it("can't go on with nothing chosen", async () => {
    await render([]);
    expect(button("Next")!.disabled).toBe(true);
    await act(async () => { field("top.nqv").click(); });
    expect(button("Next")!.disabled).toBe(false);
  });

  it("ticking a folder covers what is under it", async () => {
    await render();
    await act(async () => { field("Work").click(); });
    expect(field("Work/bank.nqv").checked).toBe(true);
    expect(field("Work/bank.nqv").disabled).toBe(true);
    expect(calls("vault_share_preview").at(-1)![1]).toEqual({ paths: ["Work"], attachments: false });
  });

  it("including attachments asks for the size again", async () => {
    await render();
    const label = Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.includes("Include attachments"))!;
    await act(async () => { (label.querySelector("input") as HTMLInputElement).click(); });
    expect(calls("vault_share_preview").at(-1)![1]).toEqual({ paths: ["Work/bank.nqv"], attachments: true });
  });

  it("a selection that can't be shared says why and stops the step", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_list") return LIST;
      if (cmd === "vault_share_preview") throw "1 of the chosen note came from a share and can't be shared again.";
      return null;
    });
    await render();
    expect(document.querySelector("[data-testid=share-preview] [role=alert]")!.textContent).toMatch(/came from a share/);
    expect(button("Next")!.disabled).toBe(true);
  });

  it("Rules: a made password, one import, a week for the file and for the items, the file deleted afterwards", async () => {
    await render();
    await next();
    expect(step()).toBe("rules");
    expect(field("Share password").value).toMatch(/^[a-z2-9]{5}(-[a-z2-9]{5}){3}$/);
    expect(field("Number of imports").value).toBe("1");
    expect(field("File expiry: amount").value).toBe("7");
    expect(document.querySelector('button[aria-label="File expiry: when"]')!.textContent).toContain("After a set time");
    expect(document.querySelector('button[aria-label="Item removal: unit"]')!.textContent).toContain("days");
    expect(Array.from(document.querySelectorAll("label")).find((l) => l.textContent?.includes("Delete the file"))!.querySelector("input")!.checked).toBe(true);
  });

  it("Rules: the time is set in hours or days, or turned off", async () => {
    await render();
    await next();
    await type(field("File expiry: amount"), "36");
    await pick("File expiry: unit", "hours");
    await pick("Item removal: when", "Never");
    expect(document.querySelector('input[aria-label="Item removal: amount"]')).toBeNull();
    expect(button("Next")!.disabled).toBe(false);
    await toConfirmFromRules();
    const lines = Array.from(document.querySelectorAll("[data-testid=share-summary] li")).map((l) => l.textContent);
    expect(lines).toContain("The file expires after 36 hours");
    expect(lines).toContain("Items are never removed");
  });

  async function toConfirmFromRules() { await next(); expect(step()).toBe("confirm"); }

  it("Rules: a wrong number stops the step and says which", async () => {
    await render();
    await next();
    await type(field("File expiry: amount"), "400");
    expect(button("Next")!.disabled).toBe(true);
    expect(document.querySelector("[data-time-group][data-invalid]")).toBeTruthy();
    expect(document.querySelector("[role=alert]")!.textContent).toBe("File expiry: enter 1 to 365 days.");
    await type(field("File expiry: amount"), "7");
    expect(document.querySelector("[role=alert]")).toBeNull();
    await type(field("Number of imports"), "0");
    expect(document.querySelector("[role=alert]")!.textContent).toBe("Number of imports: enter 1 to 100.");
    expect(button("Next")!.disabled).toBe(true);
    await type(field("Number of imports"), "100");
    expect(button("Next")!.disabled).toBe(false);
  });

  it("Back keeps what was typed", async () => {
    await render();
    await next();
    await type(field("Number of imports"), "4");
    await toConfirmFromRules();
    await act(async () => { button("Back")!.click(); });
    expect(step()).toBe("rules");
    expect(field("Number of imports").value).toBe("4");
    await act(async () => { button("Back")!.click(); });
    expect(step()).toBe("items");
    expect(field("Work/bank.nqv").checked).toBe(true);
  });

  it("Confirm: a summary, and it can't be saved until the master password is typed", async () => {
    await render();
    await toConfirm();
    expect(step()).toBe("confirm");
    expect(Array.from(document.querySelectorAll("[data-testid=share-summary] li")).map((l) => l.textContent)).toEqual([
      "1 note, 1 folder", "Can be imported 1 time", "The file expires after 7 days", "Items are removed 7 days after the import", "The file is deleted after its last import",
    ]);
    expect(button("Save share file")!.disabled).toBe(true);
    await type(field("Master password"), "the master password");
    expect(button("Save share file")!.disabled).toBe(false);
  });

  it("saves the file with every choice, then says to send the password separately", async () => {
    await render();
    await next();
    const password = field("Share password").value;
    await type(field("Number of imports"), "3");
    await type(field("File expiry: amount"), "36");
    await pick("File expiry: unit", "hours");
    await next();
    await type(field("Master password"), "the master password");
    await act(async () => { button("Save share file")!.click(); });
    expect(save).toHaveBeenCalledTimes(1);
    const args = (calls("vault_share_export")[0][1] as { args: Record<string, unknown> }).args;
    expect(args).toMatchObject({
      paths: ["Work/bank.nqv"], attachments: false, masterPassword: "the master password", sharePassword: password, maxImports: 3,
      itemLifeHours: 168, deleteFile: true, destPath: "C:/Users/me/Desktop/notiq-share.nqb",
    });
    expect(typeof args.validUntilMs).toBe("number");
    expect((args.validUntilMs as number) - Date.now()).toBeGreaterThan(35 * 3_600_000);
    expect((args.validUntilMs as number) - Date.now()).toBeLessThan(37 * 3_600_000);
    expect(step()).toBe("done");
    const done = document.querySelector("[data-testid=share-done]")!;
    expect(done.textContent).toContain(password);
    expect(done.textContent).toMatch(/Send the password separately/);
    await act(async () => { button("Show in folder")!.click(); });
    expect(reveal).toHaveBeenCalledWith("C:/Users/me/Desktop/notiq-share.nqb");
    await act(async () => { button("Done")!.click(); });
    expect(onClose).toHaveBeenCalled();
  });

  it("cancelling the save dialog writes nothing and stays on Confirm", async () => {
    save.mockResolvedValueOnce(null);
    await render();
    await toConfirm();
    await type(field("Master password"), "the master password");
    await act(async () => { button("Save share file")!.click(); });
    expect(calls("vault_share_export")).toHaveLength(0);
    expect(step()).toBe("confirm");
  });

  it("a wrong master password shows the error and does not finish", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_list") return LIST;
      if (cmd === "vault_share_preview") return PREVIEW;
      throw "Wrong password";
    });
    await render();
    await toConfirm();
    await type(field("Master password"), "not it not it");
    await act(async () => { button("Save share file")!.click(); });
    expect(document.querySelector("[role=alert]")!.textContent).toContain("Wrong password");
    expect(step()).toBe("confirm");
  });

  it("the same password as the master password is refused before anything is written", async () => {
    await render();
    await next();
    const pw = field("Share password").value;
    await next();
    await type(field("Master password"), pw);
    expect(button("Save share file")!.disabled).toBe(true);
    expect(document.querySelector("[data-testid=share-problem]")!.textContent).toMatch(/different password/);
  });
});
