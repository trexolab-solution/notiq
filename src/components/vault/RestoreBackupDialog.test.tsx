// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
const dialogOpen = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: (...a: unknown[]) => dialogOpen(...a), save: vi.fn(), ask: vi.fn() }));
const fsStat = vi.fn(async (_p: string) => ({ isDirectory: false, size: 1 }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: (p: string) => fsStat(p), exists: async () => true, mkdir: async () => {} }));
vi.mock("../../lib/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { RestoreBackupDialog } = await import("./RestoreBackupDialog");
const { useVaultStore } = await import("../../store/vaultStore");
const { useAppStore } = await import("../../store");
const { clearDropTargets, dropAt } = await import("../../lib/dropTargets");

const INFO = { ok: true, vault_id_hex: "ab", db_bytes: 4096, created: 1_700_000_000 };
const MERGED = { added: 3, updated: 1, unchanged: 5, kept_in_history: 1, previous_saved_to: "C:/data/before-merge-1" };
const IMPORTED = { vault_id_hex: "ab", db_bytes: 4096, replaced: true, previous_saved_to: "C:/data/before-restore-1" };

let host: HTMLDivElement;
let root: Root;
const onClose = vi.fn();
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const step = () => q("[data-restore-step]")?.getAttribute("data-restore-step");
const current = () => q('[aria-current="step"]')?.textContent;
const type = async (el: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const drop = async (paths: string[]) => {
  let handled = false;
  await act(async () => { handled = dropAt(paths, { x: 50, y: 50 }, 1); });
  await flush();
  return handled;
};

async function render() {
  await act(async () => { root.render(<RestoreBackupDialog onClose={onClose} />); });
  await flush();
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "vault_backup_inspect") return INFO;
    if (cmd === "vault_backup_merge") return MERGED;
    if (cmd === "vault_backup_import") return IMPORTED;
    return null;
  });
  dialogOpen.mockReset(); fsStat.mockClear(); onClose.mockReset();
  useVaultStore.setState({ exists: true, unlocked: true, refresh: async () => {} });
  useAppStore.setState({ lockVault: async () => true, refreshVaultTabs: async () => {} });
  // happy-dom has no layout: give the drop zone and the dialog a box.
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

describe("RestoreBackupDialog", () => {
  it("starts on the File step with an accessible step list", async () => {
    await render();
    const items = [...document.querySelectorAll('ol[aria-label="Restore steps"] > li')].map((li) => li.textContent);
    expect(items).toEqual(["1File", "2Method", "3Confirm", "4Done"]);
    expect(current()).toBe("1File");
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(q('[role="status"][aria-live="polite"]')).toBeTruthy();
    expect(q("[data-drop-zone]")?.textContent).toContain("Drop a .nqbackup file here");
    expect(button("Next")!.disabled).toBe(true);
    expect(document.activeElement).toBe(button("Choose file…"));
  });

  it("chooses a dropped backup, checks it and shows its card", async () => {
    await render();
    expect(await drop(["C:/Users/me/Backups/notiq-vault-2026-11-01-from-the-old-laptop-before-reinstall.nqbackup"])).toBe(true);
    expect(invoke).toHaveBeenCalledWith("vault_backup_inspect", { path: expect.stringContaining("before-reinstall.nqbackup") });
    const name = q("[data-file-name]")!;
    expect(name.getAttribute("title")).toBe("C:/Users/me/Backups/notiq-vault-2026-11-01-from-the-old-laptop-before-reinstall.nqbackup");
    expect(name.textContent).toContain("…");
    expect(name.textContent!.endsWith(".nqbackup")).toBe(true);
    expect(q("[data-file-card]")?.textContent).toContain("Valid backup");
    expect(q("[data-file-card]")?.textContent).toContain("4.0 KB");
    expect(button("Choose a different file")).toBeTruthy();
    expect(button("Next")!.disabled).toBe(false);
  });

  it("refuses other file types, several files and folders inline", async () => {
    await render();
    expect(await drop(["C:/notes/todo.md"])).toBe(true);
    expect(q('[role="alert"]')?.textContent).toMatch(/isn't a Notiq backup/);
    await drop(["C:/a.nqbackup", "C:/b.nqbackup"]);
    expect(q('[role="alert"]')?.textContent).toMatch(/one backup file at a time/);
    fsStat.mockResolvedValueOnce({ isDirectory: true, size: 0 });
    await drop(["C:/Backups"]);
    expect(q('[role="alert"]')?.textContent).toMatch(/is a folder/);
    expect(invoke).not.toHaveBeenCalledWith("vault_backup_inspect", expect.anything());
    expect(button("Next")!.disabled).toBe(true);
  });

  it("swallows drops outside the dialog while it is open", async () => {
    await render();
    let handled = false;
    await act(async () => { handled = dropAt(["C:/notes/todo.md"], { x: 900, y: 900 }, 1); });
    expect(handled).toBe(true); // not opened as a tab
    expect(invoke).not.toHaveBeenCalled();
  });

  it("merges into the unlocked vault and shows the counts", async () => {
    await render();
    dialogOpen.mockResolvedValue("C:/b.nqbackup");
    await click(button("Choose file…"));
    await click(button("Next"));
    expect(step()).toBe("method");
    expect(current()).toBe("2Method");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(q('[role="status"][aria-live="polite"]')?.textContent).toBe("Step 2 of 4: Method");
    const merge =q('[role="radio"][data-value="merge"]')!;
    expect(merge.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(merge);
    await click(button("Next"));
    expect(step()).toBe("confirm");
    const pw = q<HTMLInputElement>("#restore-backup-password")!;
    expect(document.activeElement).toBe(pw);
    expect(button("Merge into vault")!.disabled).toBe(true);
    await type(pw, "backup-pw");
    await click(button("Merge into vault"));
    expect(invoke).toHaveBeenCalledWith("vault_backup_merge", { path: "C:/b.nqbackup", password: "backup-pw" });
    expect(step()).toBe("done");
    expect(current()).toBe("4Done");
    expect(q("[data-merge-counts]")?.textContent).toContain("Added");
    expect(document.body.textContent).toContain("Added 3 notes, updated 1, 5 unchanged, 1 older version kept in history.");
    expect(document.body.textContent).toContain("C:/data/before-merge-1");
    await click(button("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps a wrong password on the Confirm step with an inline error", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "vault_backup_inspect") return INFO;
      if (cmd === "vault_backup_merge") throw "Wrong password";
      return null;
    });
    await render();
    await drop(["C:/b.nqbackup"]);
    await click(button("Next"));
    await click(button("Next"));
    const pw = q<HTMLInputElement>("#restore-backup-password")!;
    await type(pw, "nope");
    await click(button("Merge into vault"));
    expect(step()).toBe("confirm");
    expect(pw.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById(pw.getAttribute("aria-describedby")!)?.textContent)
      .toContain("isn't the master password this backup was made with");
  });

  it("asks to unlock first when merging into a locked vault", async () => {
    useVaultStore.setState({ unlocked: false });
    await render();
    await drop(["C:/b.nqbackup"]);
    await click(button("Next"));
    expect(button("Unlock vault…")).toBeTruthy();
    expect(button("Next")!.disabled).toBe(true);
  });

  it("replaces after typing REPLACE, then reports where the old vault went", async () => {
    await render();
    await drop(["C:/b.nqbackup"]);
    await click(button("Next"));
    const replace = q('[role="radio"][data-value="replace"]')!;
    // Arrow keys move the selection within the group.
    await act(async () => { merge().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(replace.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(replace);
    await click(button("Next"));
    const btn = button("Replace vault")!;
    expect(btn.disabled).toBe(true);
    await type(q<HTMLInputElement>("#restore-confirm")!, "REPLACE");
    await click(button("Replace vault"));
    expect(invoke).toHaveBeenCalledWith("vault_backup_import", { path: "C:/b.nqbackup", replace: true });
    expect(step()).toBe("done");
    expect(document.body.textContent).toContain("Your vault was restored.");
    expect(document.body.textContent).toContain("C:/data/before-restore-1");
    expect(button("Close")).toBeTruthy();
  });

  it("skips the Method step when no vault exists, and Back keeps the chosen file", async () => {
    useVaultStore.setState({ exists: false, unlocked: false });
    await render();
    expect([...document.querySelectorAll('ol[aria-label="Restore steps"] > li')].map((li) => li.textContent))
      .toEqual(["1File", "2Confirm", "3Done"]);
    await drop(["C:/b.nqbackup"]);
    await click(button("Next"));
    expect(step()).toBe("confirm");
    await click(button("Back"));
    expect(step()).toBe("file");
    expect(q("[data-file-card]")?.textContent).toContain("Valid backup"); // the choice is kept
    await click(button("Next"));
    await click(button("Restore vault"));
    expect(invoke).toHaveBeenCalledWith("vault_backup_import", { path: "C:/b.nqbackup", replace: false });
    expect(step()).toBe("done");
  });
});

const merge = () => q('[role="radio"][data-value="merge"]')!;
