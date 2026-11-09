// @vitest-environment happy-dom
/**
 * Settings → Sync → "Restore vault from a date…": restore points grouped by date with device names
 * (never ids), confirm with the merge explanation, progress, result summary, failure handling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));
const toastSuccess = vi.fn();
vi.mock("../../../lib/toast", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SyncHistoryDialog } = await import("./SyncHistoryDialog");
const { RestoreFromDateRow } = await import("./SyncHistoryRow");
const { groupRestorePoints, describeRestore } = await import("../../../lib/syncHistory");
const { useVaultStore } = await import("../../../store/vaultStore");
type RestorePoint = import("../../../lib/syncHistory").RestorePoint;
type RestoreSummary = import("../../../lib/syncHistory").RestoreSummary;

const RAW_ID = "623dc26ac14b29a54ac147abce02d215";
const pt = (date: string, deviceName: string, thisDevice: boolean, extra: Partial<RestorePoint> = {}): RestorePoint => ({
  id: `history/${thisDevice ? "a".repeat(32) : RAW_ID}/${date.replace(/-/g, "")}.nqs`,
  date, takenMs: Date.UTC(2026, 10, 9, 10, 30), deviceName, thisDevice, size: 120_000, kind: "daily", ...extra,
});
const POINTS: RestorePoint[] = [
  pt("2026-11-09", "DESK", true),
  pt("2026-11-09", "", false),
  pt("2026-11-08", "LAPTOP", false, { id: `history/${RAW_ID}/20261108.nqs` }),
];
const SUMMARY: RestoreSummary = {
  added: 3, updated: 0, unchanged: 5, keptInHistory: 1, attachmentsMissing: 0,
  backupPath: "C:\\Users\\me\\AppData\\Roaming\\notiq\\vault-sync-backups\\safety-1-before-history-restore.nqbackup", date: "2026-11-08",
};

let host: HTMLDivElement;
let root: Root;
const ensureUnlocked = vi.fn(async () => true);
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  invoke.mockReset();
  toastSuccess.mockReset();
  ensureUnlocked.mockReset();
  ensureUnlocked.mockResolvedValue(true);
  useVaultStore.setState({ exists: true, unlocked: true, ensureUnlocked });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const button = (label: string) =>
  Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = (el: Element | undefined | null) => act(async () => { (el as HTMLElement).click(); });

async function open(onClose = vi.fn()) {
  await act(async () => { root.render(<SyncHistoryDialog onClose={onClose} />); });
  await flush();
  return onClose;
}

describe("restore points", () => {
  it("are grouped by date (newest first), this PC first, with names and never ids", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "sync_history_list" ? POINTS : null));
    await open();
    const dialog = document.querySelector('[data-testid="sync-history-dialog"]')!;
    expect(dialog.getAttribute("role")).toBe("dialog");
    const groups = Array.from(dialog.querySelectorAll('[role="radiogroup"] > [role="group"]'));
    expect(groups).toHaveLength(2);
    expect(groups[0].textContent).toContain("2026");
    expect(groups[0].textContent).toMatch(/9/);
    const rows = Array.from(groups[0].querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(rows[0]).toContain("DESK");
    expect(rows[0]).toContain("This PC");
    expect(rows[1]).toContain("Unnamed device");
    expect(groups[1].textContent).toContain("LAPTOP");
    expect(dialog.textContent).not.toContain(RAW_ID);
    // Each radio has an accessible name with the date and device.
    const radios = Array.from(dialog.querySelectorAll('input[type="radio"]'));
    expect(radios).toHaveLength(3);
    expect(radios[2].getAttribute("aria-label")).toContain("LAPTOP");
    expect(button("Continue…")!.disabled).toBe(true);
  });

  it("shows an empty state and a load error with Retry", async () => {
    invoke.mockImplementation(async () => []);
    await open();
    expect(document.body.textContent).toContain("no restore points yet");

    await act(async () => root.unmount());
    root = createRoot(host);
    invoke.mockImplementation(async () => { throw "SYNC_OFFLINE"; });
    await open();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain("Couldn't load the restore points");
    invoke.mockImplementation(async () => POINTS);
    await click(button("Retry"));
    await flush();
    expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(3);
  });
});

describe("restoring", () => {
  it("confirms with the merge explanation, restores the chosen point and shows the summary", async () => {
    let finish: (s: RestoreSummary) => void = () => {};
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_history_list") return POINTS;
      if (cmd === "sync_history_restore") return new Promise<RestoreSummary>((r) => { finish = r; });
      return null;
    });
    const onClose = await open();
    await click(document.querySelectorAll('input[type="radio"]')[2]);
    await click(button("Continue…"));
    const text = document.body.textContent ?? "";
    expect(text).toContain("LAPTOP");
    expect(text).toContain("come back and are merged");
    expect(text).toContain("Nothing is removed");
    expect(text).toContain("backup of your vault is saved");

    await click(button("Restore"));
    expect(ensureUnlocked).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("sync_history_restore", { point: `history/${RAW_ID}/20261108.nqs` });
    expect(document.querySelector('[role="status"]')!.textContent).toContain("Restoring");
    expect(button("Back")!.disabled).toBe(true);
    // Not dismissable while restoring.
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => { finish(SUMMARY); });
    await flush();
    const done = document.body.textContent ?? "";
    expect(done).toContain("3 notes came back");
    expect(done).toContain("1 note changed since then kept its newer text");
    expect(done).toContain("safety-1-before-history-restore.nqbackup");
    expect(toastSuccess).toHaveBeenCalledTimes(1);
    await click(button("Done"));
    expect(onClose).toHaveBeenCalled();
  });

  it("a failed restore says the vault wasn't changed and can be retried", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "sync_history_list") return POINTS;
      if (cmd === "sync_history_restore") throw "This restore point couldn't be verified (tampered); nothing was changed.";
      return null;
    });
    await open();
    await click(document.querySelectorAll('input[type="radio"]')[0]);
    await click(button("Continue…"));
    await click(button("Restore"));
    await flush();
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("couldn't be verified");
    expect(alert.textContent).toContain("wasn't changed");
    expect(button("Try again")).toBeDefined();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("does nothing when the unlock is cancelled", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "sync_history_list" ? POINTS : null));
    ensureUnlocked.mockResolvedValue(false);
    await open();
    await click(document.querySelectorAll('input[type="radio"]')[0]);
    await click(button("Continue…"));
    await click(button("Restore"));
    expect(invoke).not.toHaveBeenCalledWith("sync_history_restore", expect.anything());
  });
});

describe("Settings row", () => {
  it("opens the dialog", async () => {
    invoke.mockImplementation(async () => POINTS);
    await act(async () => { root.render(<RestoreFromDateRow />); });
    expect(document.querySelector('[data-testid="sync-history-dialog"]')).toBeNull();
    await click(button("Restore from a date…"));
    await flush();
    expect(document.querySelector('[data-testid="sync-history-dialog"]')).not.toBeNull();
  });
});

describe("helpers", () => {
  it("group and describe", () => {
    const g = groupRestorePoints(POINTS);
    expect(g.map((x) => x.date)).toEqual(["2026-11-09", "2026-11-08"]);
    expect(g[0].points[0].thisDevice).toBe(true);
    expect(describeRestore({ ...SUMMARY, added: 0, keptInHistory: 0 })).toContain("Nothing was missing");
    expect(describeRestore({ ...SUMMARY, attachmentsMissing: 2 })).toContain("2 attachments weren't in your Drive");
  });
});
