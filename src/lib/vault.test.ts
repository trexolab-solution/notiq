import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  VAULT_CHANGED_EVENT, vaultDuplicate, vaultEmptyTrash, vaultList, vaultListTrash, vaultMkdir, vaultPurge,
  vaultRename, vaultRestore, vaultSetStarred, vaultSetTags, vaultTrash, vaultErrorMessage,
} from "./vault";

const win = new EventTarget();
vi.stubGlobal("window", win);

let events = 0;
win.addEventListener(VAULT_CHANGED_EVENT, () => { events++; });

describe("vault entry wrappers", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    events = 0;
  });

  it("lists without broadcasting a change", async () => {
    invoke.mockResolvedValueOnce([{ rel: "a.nqv" }]);
    await expect(vaultList()).resolves.toEqual([{ rel: "a.nqv" }]);
    await vaultListTrash();
    expect(invoke.mock.calls).toEqual([["vault_list"], ["vault_list_trash"]]);
    expect(events).toBe(0);
  });

  it("passes the contract argument names and broadcasts after mutations", async () => {
    const P = "C:/V/a.nqv";
    await vaultMkdir("C:/V/Work");
    await vaultRename(P, "C:/V/b.nqv");
    await vaultTrash(P);
    await vaultRestore(P);
    await vaultPurge(P);
    await vaultEmptyTrash();
    await vaultSetTags(P, ["x"]);
    await vaultSetStarred(P, true);
    expect(invoke.mock.calls).toEqual([
      ["vault_mkdir", { path: "C:/V/Work" }],
      ["vault_rename", { from: P, to: "C:/V/b.nqv" }],
      ["vault_trash", { path: P }],
      ["vault_restore", { path: P }],
      ["vault_purge", { path: P }],
      ["vault_empty_trash"],
      ["vault_set_tags", { path: P, tags: ["x"] }],
      ["vault_set_starred", { path: P, starred: true }],
    ]);
    expect(events).toBe(8);
  });

  it("duplicate resolves the new path", async () => {
    invoke.mockResolvedValueOnce("C:/V/a 2.nqv");
    await expect(vaultDuplicate("C:/V/a.nqv")).resolves.toBe("C:/V/a 2.nqv");
  });

  it("does not broadcast when the command fails", async () => {
    invoke.mockRejectedValueOnce("VAULT_LOCKED");
    await expect(vaultTrash("C:/V/a.nqv")).rejects.toBe("VAULT_LOCKED");
    expect(events).toBe(0);
    expect(vaultErrorMessage("VAULT_LOCKED")).toBe("The vault is locked");
  });
});
