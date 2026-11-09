// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { DeletionGuardView, DeletionGuardDialog } = await import("./DeletionGuardDialog");
const { useSyncStore } = await import("../../../lib/vaultSync");
const { useDeletionGuardUi } = await import("../../../lib/syncDeletionGuard");
type PendingDeletions = import("../../../lib/vaultSync").PendingDeletions;

const pending: PendingDeletions = {
  removing: 8, remoteLive: 10, reason: "large", backupDir: "C:/app/backups",
  titles: ["Bank", "Mail", "Wifi", "Router", "Git", "Extra"],
};
const btn = (t: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const mount = async (node: React.ReactElement) => {
  host = document.createElement("div"); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(node); });
};
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove(); root = null; host = null;
  useSyncStore.setState({ status: null });
  useDeletionGuardUi.setState({ dismissedKey: null, busy: null });
});

describe("DeletionGuardView", () => {
  it("is an accessible alertdialog with counts, up to 5 titles, backup folder; focus on the safe action", async () => {
    await mount(<DeletionGuardView pending={pending} busy={null} onRestore={vi.fn()} onApply={vi.fn()} onLater={vi.fn()} />);
    const dlg = document.querySelector('[role="alertdialog"]')!;
    expect(dlg.getAttribute("aria-modal")).toBe("true");
    expect(dlg.textContent).toContain("Delete 8 items from Google Drive?");
    expect(dlg.textContent).toContain("8 of the 10 items");
    expect(dlg.querySelectorAll("li")).toHaveLength(6); // 5 titles + "and 3 more"
    expect(dlg.textContent).toContain("and 3 more");
    expect(dlg.textContent).not.toContain("Extra");
    expect(dlg.textContent).toContain("C:/app/backups");
    expect(document.activeElement).toBe(btn("Restore from Drive"));
  });

  it("buttons call their handlers; busy disables them", async () => {
    const onRestore = vi.fn(), onApply = vi.fn(), onLater = vi.fn();
    await mount(<DeletionGuardView pending={pending} busy={null} onRestore={onRestore} onApply={onApply} onLater={onLater} />);
    await act(async () => { btn("Apply deletions everywhere")!.click(); });
    await act(async () => { btn("Restore from Drive")!.click(); });
    await act(async () => { btn("Decide later")!.click(); });
    expect([onApply, onRestore, onLater].map((f) => f.mock.calls.length)).toEqual([1, 1, 1]);
    await act(async () => { root!.render(<DeletionGuardView pending={pending} busy="apply" onRestore={onRestore} onApply={onApply} onLater={onLater} />); });
    expect(btn("Decide later")!.disabled).toBe(true);
  });
});

describe("DeletionGuardDialog (store driven)", () => {
  const st = (state: "awaitingConfirm" | "idle") => ({
    configured: true, provider: "gdrive" as const, account: "a", enabled: true, state, lastSyncedMs: null, lastError: null,
    pending: false, deviceId: "d", deviceName: "D", pendingDeletions: state === "idle" ? null : pending,
  });
  it("shows while awaiting, 'Decide later' hides it, Review reopens it", async () => {
    useSyncStore.setState({ status: st("awaitingConfirm") });
    await mount(<DeletionGuardDialog />);
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
    await act(async () => { btn("Decide later")!.click(); });
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    await act(async () => { useDeletionGuardUi.getState().reopen(); });
    expect(document.querySelector('[role="alertdialog"]')).toBeTruthy();
  });
  it("renders nothing when not awaiting", async () => {
    useSyncStore.setState({ status: st("idle") });
    await mount(<DeletionGuardDialog />);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });
});
