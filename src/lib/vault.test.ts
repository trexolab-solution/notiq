import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  VAULT_CHANGED_EVENT, vaultDuplicate, vaultEmptyTrash, vaultList, vaultListTrash, vaultMkdir, vaultPurge,
  vaultRename, vaultRestore, vaultSetStarred, vaultSetTags, vaultTrash, vaultErrorMessage,
  vaultHistoryList, vaultHistoryGet, vaultHistoryRestore, vaultAttachAdd, vaultAttachList, vaultAttachGet,
  vaultAttachExport, vaultAttachRemove, bytesToBase64, base64ToBytes,
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

  it("history wrappers use the contract names; only restore broadcasts", async () => {
    const P = "C:/V/a.nqv";
    invoke.mockResolvedValueOnce([{ index: 0, updated: 1, ext: "md", size: 3 }]);
    await expect(vaultHistoryList(P)).resolves.toEqual([{ index: 0, updated: 1, ext: "md", size: 3 }]);
    invoke.mockResolvedValueOnce({ content: "old", ext: "md" });
    await expect(vaultHistoryGet(P, 2)).resolves.toEqual({ content: "old", ext: "md" });
    expect(events).toBe(0);
    await vaultHistoryRestore(P, 2);
    expect(events).toBe(1);
    expect(invoke.mock.calls).toEqual([
      ["vault_history_list", { path: P }],
      ["vault_history_get", { path: P, index: 2 }],
      ["vault_history_restore", { path: P, index: 2 }],
    ]);
  });

  it("attachment wrappers use the contract names; add/remove broadcast", async () => {
    const P = "C:/V/a.nqv";
    const meta = { id: "0".repeat(32), name: "a.png", mime: "image/png", size: 4, added: 9 };
    invoke.mockResolvedValueOnce(meta);
    await expect(vaultAttachAdd(P, "a.png", "AAAA")).resolves.toEqual(meta);
    invoke.mockResolvedValueOnce([meta]);
    await expect(vaultAttachList(P)).resolves.toEqual([meta]);
    invoke.mockResolvedValueOnce("AAAA");
    await expect(vaultAttachGet(P, meta.id)).resolves.toBe("AAAA");
    await vaultAttachExport(P, meta.id, "C:/out/a.png");
    await vaultAttachExport(P, meta.id, "C:/out/a.png", true);
    await vaultAttachRemove(P, meta.id);
    expect(invoke.mock.calls).toEqual([
      ["vault_attach_add", { path: P, name: "a.png", dataB64: "AAAA" }],
      ["vault_attach_list", { path: P }],
      ["vault_attach_get", { path: P, id: meta.id }],
      ["vault_attach_export", { path: P, id: meta.id, destPath: "C:/out/a.png", overwrite: false }],
      ["vault_attach_export", { path: P, id: meta.id, destPath: "C:/out/a.png", overwrite: true }],
      ["vault_attach_remove", { path: P, id: meta.id }],
    ]);
    expect(events).toBe(2);
  });

  it("base64 helpers round-trip bytes, including large buffers", () => {
    expect(bytesToBase64(new TextEncoder().encode("foobar"))).toBe("Zm9vYmFy");
    expect(Array.from(base64ToBytes("Zm8="))).toEqual([102, 111]);
    const big = new Uint8Array(200_000).map((_, i) => (i * 31) & 255);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });

  it("does not broadcast when the command fails", async () => {
    invoke.mockRejectedValueOnce("VAULT_LOCKED");
    await expect(vaultTrash("C:/V/a.nqv")).rejects.toBe("VAULT_LOCKED");
    expect(events).toBe(0);
    expect(vaultErrorMessage("VAULT_LOCKED")).toBe("The vault is locked");
  });
});
