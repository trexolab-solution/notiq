import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));

const F = await import("./vaultSyncFlows");
const { useSyncStore } = await import("./vaultSync");
type SyncStatus = import("./vaultSync").SyncStatus;

const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: null, lastError: null, pending: false, deviceId: "d1", deviceName: "Desk", ...o,
});

/** Route invoke by command name. */
function route(map: Record<string, unknown | ((args: unknown) => unknown)>) {
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const v = map[cmd];
    if (typeof v === "function") return (v as (a: unknown) => unknown)(args);
    if (v instanceof Error) throw v.message;
    return v;
  });
}
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const reject = (code: string) => () => { throw code; };

beforeEach(() => {
  invoke.mockReset();
  useSyncStore.setState({ status: null });
});

describe("enableSync", () => {
  it("returns the result when sync turned on", async () => {
    route({ sync_enable: { added: 1, updated: 0, removed: 0, conflicts: [] }, sync_status: status() });
    await expect(F.enableSync()).resolves.toEqual({ kind: "enabled", result: { added: 1, updated: 0, removed: 0, conflicts: [] } });
  });

  it("asks for the A/B/C dialog on REMOTE_VAULT_DIFFERENT", async () => {
    route({ sync_enable: reject("REMOTE_VAULT_DIFFERENT") });
    await expect(F.enableSync()).resolves.toEqual({ kind: "different" });
  });

  it("reports other errors in words", async () => {
    route({ sync_enable: reject("SYNC_OFFLINE") });
    const out = await F.enableSync();
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.error).toMatch(/offline/i);
  });
});

describe("A/B/C dialog (runAdopt)", () => {
  const RESULT = { backupPath: "C:/b/vault.nqbackup", imported: 3, skipped: 2, renamed: 1 };
  const base = { remotePassword: "remote-pw", localPassword: "", localUnlocked: true };

  it("defaults to A (import)", () => {
    expect(F.DEFAULT_ADOPT_CHOICE).toBe("import");
  });

  it("C cancels without calling anything", async () => {
    await expect(F.runAdopt({ ...base, choice: "cancel" })).resolves.toEqual({ kind: "cancelled" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("A with an unlocked vault sends only the synced vault's password", async () => {
    route({ sync_adopt_remote: RESULT, sync_status: status({ enabled: true }) });
    const out = await F.runAdopt({ ...base, choice: "import" });
    expect(out).toEqual({ kind: "done", result: RESULT, mode: "import" });
    expect(calls("sync_adopt_remote")).toEqual([["sync_adopt_remote", { remotePassword: "remote-pw", mode: "import" }]]);
    expect(calls("sync_enable")).toHaveLength(0);
  });

  it("A with a locked vault needs and sends this PC's password", async () => {
    expect(F.adoptNeedsLocalPassword("import", false)).toBe(true);
    expect(F.adoptNeedsLocalPassword("import", true)).toBe(false);
    expect(F.adoptNeedsLocalPassword("backupOnly", false)).toBe(false);
    const missing = await F.runAdopt({ ...base, choice: "import", localUnlocked: false });
    expect(missing).toMatchObject({ kind: "invalid", field: "local" });
    route({ sync_adopt_remote: RESULT, sync_status: status() });
    await F.runAdopt({ ...base, choice: "import", localUnlocked: false, localPassword: "local-pw" });
    expect(calls("sync_adopt_remote")[0][1]).toEqual({ remotePassword: "remote-pw", mode: "import", localPassword: "local-pw" });
  });

  it("B sends backupOnly and never the local password", async () => {
    route({ sync_adopt_remote: RESULT, sync_status: status() });
    await F.runAdopt({ ...base, choice: "backupOnly", localUnlocked: false, localPassword: "local-pw" });
    expect(calls("sync_adopt_remote")[0][1]).toEqual({ remotePassword: "remote-pw", mode: "backupOnly" });
  });

  it("requires the synced vault's password", async () => {
    await expect(F.runAdopt({ ...base, choice: "import", remotePassword: "" })).resolves.toMatchObject({ kind: "invalid", field: "remote" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("turns sync on afterwards if the backend left it off", async () => {
    route({ sync_adopt_remote: RESULT, sync_status: status({ enabled: false, state: "off" }), sync_enable: { added: 0, updated: 0, removed: 0, conflicts: [] } });
    await F.runAdopt({ ...base, choice: "import" });
    expect(calls("sync_enable")).toHaveLength(1);
  });

  it("maps WRONG_PASSWORD to an inline error", async () => {
    route({ sync_adopt_remote: reject("WRONG_PASSWORD") });
    const out = await F.runAdopt({ ...base, choice: "import" });
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.error).toMatch(/^Wrong password/);
  });

  it("describes the result, with the backup path and counts", () => {
    const lines = F.describeAdoptResult(RESULT, "import");
    expect(lines[0]).toContain("C:/b/vault.nqbackup");
    expect(lines.join(" ")).toContain("3 entries were imported");
    expect(lines.join(" ")).toContain("2 identical entries were skipped");
    expect(lines.join(" ")).toContain("(This PC)");
    expect(F.describeAdoptResult(RESULT, "backupOnly")).toHaveLength(1);
    expect(F.HELLO_RESET_NOTE).toMatch(/Windows Hello/);
  });
});

describe("join from Google Drive", () => {
  it("starts at notConfigured / connect / noRemote / password", async () => {
    await expect(F.joinStep(status({ configured: false }))).resolves.toEqual({ step: "notConfigured" });
    await expect(F.joinStep(null)).resolves.toEqual({ step: "notConfigured" });
    await expect(F.joinStep(status({ provider: null }))).resolves.toEqual({ step: "connect" });
    route({ sync_remote_info: { exists: false, sameVault: null } });
    await expect(F.joinStep(status())).resolves.toEqual({ step: "noRemote" });
    route({ sync_remote_info: { exists: true, sameVault: null } });
    await expect(F.joinStep(status())).resolves.toEqual({ step: "password" });
  });

  it("falls back to connect when Google needs a new sign-in", async () => {
    route({ sync_remote_info: reject("SYNC_AUTH") });
    const out = await F.joinStep(status());
    expect(out.step).toBe("connect");
    expect(out.error).toMatch(/sign in again/);
  });

  it("joins with the password", async () => {
    route({ sync_join: undefined, sync_status: status() });
    await expect(F.runJoin("pw")).resolves.toEqual({ kind: "joined" });
    expect(calls("sync_join")).toEqual([["sync_join", { password: "pw" }]]);
  });

  it("WRONG_PASSWORD stays on the password step with an inline error", async () => {
    route({ sync_join: reject("WRONG_PASSWORD") });
    const out = await F.runJoin("nope");
    expect(out.kind).toBe("wrongPassword");
    expect(out.kind === "wrongPassword" && out.error).toMatch(/Wrong master password/);
  });

  it("NO_REMOTE_VAULT switches to the friendly message", async () => {
    route({ sync_join: reject("NO_REMOTE_VAULT") });
    await expect(F.runJoin("pw")).resolves.toEqual({ kind: "noRemote" });
  });

  it("an empty password never reaches the backend", async () => {
    await expect(F.runJoin("")).resolves.toMatchObject({ kind: "wrongPassword" });
    expect(invoke).not.toHaveBeenCalled();
  });
});
