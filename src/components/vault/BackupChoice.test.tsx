// @vitest-environment happy-dom
/**
 * Settings -> Vault -> Backup: one Export and one Import. Each opens a choice (a backup of the whole vault or sharing
 * chosen items; restoring a backup or importing shared items), and a file dropped on the Import choice opens the
 * right flow by itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ stat: vi.fn(async () => ({ isDirectory: false })) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn(), openUrl: vi.fn() }));
const toast = { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() };
vi.mock("../../lib/toast", () => ({ toast }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { BackupSection } = await import("./BackupSection");
const { useVaultStore } = await import("../../store/vaultStore");
const { clearDropTargets, dropAt } = await import("../../lib/dropTargets");

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(label)) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const card = (value: string) => document.querySelector(`[role=radio][data-value="${value}"]`) as HTMLElement;
const inspectAs = (kind: "backup" | "share") => invoke.mockImplementation(async (cmd: string) => (cmd === "vault_backup_inspect" ? { ok: true, kind, vault_id_hex: "ab", db_bytes: 10, created: null } : cmd === "vault_list" ? [] : null));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => (cmd === "vault_list" ? [] : null));
  Object.values(toast).forEach((f) => f.mockReset());
  useVaultStore.setState({ exists: true, unlocked: true, refresh: async () => {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const box = this.classList.contains("dlg-panel") ? 600 : this.hasAttribute("data-drop-zone") ? 300 : 0;
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

const render = async () => { await act(async () => { root.render(<BackupSection />); }); await flush(); };

describe("backup settings rows", () => {
  it("has one Export and one Import, and no separate rows for sharing", async () => {
    await render();
    expect(document.getElementById("setting-vault.backup.export")).toBeTruthy();
    expect(document.getElementById("setting-vault.backup.import")).toBeTruthy();
    expect(document.getElementById("setting-vault.backup.share")).toBeNull();
    expect(document.getElementById("setting-vault.backup.shared")).toBeNull();
    expect(button("Export…")).toBeTruthy();
    expect(button("Import…")).toBeTruthy();
    expect(document.getElementById("setting-vault.backup.export")!.textContent).toMatch(/share chosen items/);
    expect(document.getElementById("setting-vault.backup.import")!.textContent).toMatch(/shared with you/);
  });
});

describe("Export choice", () => {
  it("offers a backup of the vault or sharing chosen items, the backup first", async () => {
    await render();
    await click(button("Export…"));
    expect(card("backup")).toBeTruthy();
    expect(card("share")).toBeTruthy();
    expect(card("backup").getAttribute("aria-checked")).toBe("true");
    expect(card("backup").textContent).toMatch(/Backup of my vault/);
    expect(card("share").textContent).toMatch(/Share chosen items/);
  });

  it("the backup goes on to the master password prompt, as before", async () => {
    await render();
    await click(button("Export…"));
    await click(button("Continue"));
    expect(document.querySelector("[aria-label='Confirm master password']")).toBeTruthy();
    expect(document.querySelector("[data-share-step]")).toBeNull();
  });

  it("sharing opens the Share items stepper", async () => {
    await render();
    await click(button("Export…"));
    await click(card("share"));
    await click(button("Continue"));
    expect(document.querySelector("[data-share-step=items]")).toBeTruthy();
  });

  it("Cancel closes the choice and does nothing", async () => {
    await render();
    await click(button("Export…"));
    await click(button("Cancel"));
    expect(document.querySelector("[role=radiogroup]")).toBeNull();
    expect(document.querySelector("[data-share-step]")).toBeNull();
  });
});

describe("Import choice", () => {
  it("offers to restore a backup or import shared items, and says a drop works", async () => {
    await render();
    await click(button("Import…"));
    expect(card("restore").getAttribute("aria-checked")).toBe("true");
    expect(card("share").textContent).toMatch(/Import shared items/);
    expect(document.body.textContent).toMatch(/drop the file here/);
  });

  it("restoring opens the restore dialog", async () => {
    await render();
    await click(button("Import…"));
    await click(button("Continue"));
    expect(document.querySelector("[data-restore-step=file]")).toBeTruthy();
  });

  it("shared items open the share import", async () => {
    await render();
    await click(button("Import…"));
    await click(card("share"));
    await click(button("Continue"));
    expect(document.querySelector("[data-import-step=file]")).toBeTruthy();
  });

  it("a share file dropped on the choice opens the share import with that file", async () => {
    inspectAs("share");
    await render();
    await click(button("Import…"));
    await act(async () => { dropAt(["C:/Users/me/Downloads/friend.nqb"], { x: 50, y: 50 }, 1); });
    await flush(); await flush();
    expect(document.querySelector("[data-import-step=file]")).toBeTruthy();
    expect(document.querySelector("[data-file-card]")!.textContent).toContain("friend.nqb");
  });

  it("a backup file dropped on the choice opens the restore with that file", async () => {
    inspectAs("backup");
    await render();
    await click(button("Import…"));
    await act(async () => { dropAt(["C:/Users/me/Downloads/vault.nqb"], { x: 50, y: 50 }, 1); });
    await flush(); await flush();
    expect(document.querySelector("[data-restore-step]")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("vault_backup_inspect", { path: "C:/Users/me/Downloads/vault.nqb" });
  });

  it("something that is not a backup file is told so and nothing opens", async () => {
    await render();
    await click(button("Import…"));
    await act(async () => { dropAt(["C:/notes/todo.md"], { x: 50, y: 50 }, 1); });
    await flush();
    expect(toast.error).toHaveBeenCalled();
    expect(document.querySelector("[data-import-step]")).toBeNull();
    expect(document.querySelector("[data-restore-step]")).toBeNull();
  });
});
