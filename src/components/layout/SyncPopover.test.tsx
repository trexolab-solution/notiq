// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => {}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SyncPopoverHost, SyncPopoverPanel, useSyncPopoverStore, openSyncPopover, resetDeviceCache } = await import("./SyncPopover");
const { SyncIndicator } = await import("./SyncIndicator");
const { useSyncStore } = await import("../../lib/vaultSync");
const { useVaultStore } = await import("../../store/vaultStore");
const { useAppStore } = await import("../../store");
const { popoverModel, INDICATOR_TIP_KEY } = await import("../../lib/syncSurfaces");
type SyncStatus = import("../../lib/vaultSync").SyncStatus;

const status = (o: Partial<SyncStatus> = {}): SyncStatus => ({
  configured: true, provider: "gdrive", account: "me@gmail.com", enabled: true, state: "idle",
  lastSyncedMs: Date.now() - 60_000, lastError: null, pending: false, deviceId: "d1", deviceName: "Desk", ...o,
});

let host: HTMLDivElement;
let root: Root;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const render = async (ui: React.ReactNode) => { await act(async () => { root.render(ui); }); };
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const pop = () => q('[role="dialog"]');
const press = (key: string, opts: KeyboardEventInit = {}) =>
  act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...opts })); });
const mousedown = (el: Element) => act(async () => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "sync_devices") return [{ id: "a" }, { id: "b" }, { id: "c" }];
    if (cmd === "sync_now" || cmd === "sync_enable") return { added: 0, updated: 0, removed: 0, conflicts: [] };
    if (cmd === "sync_status") return useSyncStore.getState().status;
    if (cmd === "sync_connect") return status();
    return null;
  });
  resetDeviceCache();
  useSyncPopoverStore.setState({ open: false, anchor: null, intent: null });
  useSyncStore.setState({ status: status(), error: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  localStorage.clear();
});

function Panel({ onClose, anchor, onAction = () => {} }: { onClose: () => void; anchor: HTMLElement; onAction?: (a: string) => void }) {
  return (
    <SyncPopoverPanel model={popoverModel(status())} anchor={anchor} deviceCount={2} busy={null}
                      connecting={false} connectError={null} onAction={onAction} onCancelConnect={() => {}} onClose={onClose} />
  );
}

describe("SyncPopoverPanel", () => {
  const mkAnchor = () => {
    const a = document.createElement("button");
    a.textContent = "anchor";
    document.body.appendChild(a);
    a.focus();
    return a;
  };

  it("is a labelled dialog that takes focus and shows account, PC and device count", async () => {
    const anchor = mkAnchor();
    await render(<Panel anchor={anchor} onClose={() => {}} />);
    const d = pop()!;
    expect(d.getAttribute("aria-labelledby")).toBe("sync-pop-title");
    expect(q("#sync-pop-title")!.textContent).toBe("Vault sync");
    expect(d.contains(document.activeElement)).toBe(true);
    expect(d.textContent).toContain("me@gmail.com");
    expect(d.textContent).toContain("Google Drive · This PC: Desk");
    expect(d.textContent).toContain("2 devices");
    expect(d.textContent).toContain("Last synced 1 minute ago");
  });

  it("closes on Escape and on a click outside, not on a click inside or on the trigger", async () => {
    const anchor = mkAnchor();
    const onClose = vi.fn();
    await render(<Panel anchor={anchor} onClose={onClose} />);
    await mousedown(pop()!);
    await mousedown(anchor);
    expect(onClose).not.toHaveBeenCalled();
    await mousedown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
    await press("Escape");
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("keeps Tab inside and returns focus to the trigger when closed", async () => {
    const anchor = mkAnchor();
    await render(<Panel anchor={anchor} onClose={() => {}} />);
    const buttons = Array.from(pop()!.querySelectorAll("button"));
    buttons[buttons.length - 1].focus();
    await press("Tab");
    expect(document.activeElement).toBe(buttons[0]);
    await press("Tab", { shiftKey: true });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    await render(null);
    expect(document.activeElement).toBe(anchor);
  });

  it("buttons report their action", async () => {
    const onAction = vi.fn();
    await render(<Panel anchor={mkAnchor()} onClose={() => {}} onAction={onAction} />);
    await click(q('[data-action="syncNow"]')!);
    await click(q('[data-action="settings"]')!);
    expect(onAction.mock.calls.map((c) => c[0])).toEqual(["syncNow", "settings"]);
  });
});

describe("SyncPopoverHost", () => {
  function App() {
    const toggle = useSyncPopoverStore((s) => s.toggle);
    const open = useSyncPopoverStore((s) => s.open);
    return (
      <div className="status-bar">
        <SyncIndicator status={useSyncStore((s) => s.status)} vaultExists expanded={open} onOpen={toggle} />
        <SyncPopoverHost />
      </div>
    );
  }
  const trigger = () => q<HTMLButtonElement>('[data-tour="sync-indicator"]')!;

  it("the indicator toggles the popover; Escape closes it and focus goes back", async () => {
    await render(<App />);
    expect(pop()).toBeNull();
    trigger().focus();
    await click(trigger());
    expect(pop()).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    await press("Escape");
    expect(pop()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    await click(trigger());
    await click(trigger());
    expect(pop()).toBeNull();
  });

  it("opens on notiq:open-sync-popover and loads the device count lazily", async () => {
    await render(<App />);
    expect(invoke).not.toHaveBeenCalledWith("sync_devices", undefined);
    await act(async () => { window.dispatchEvent(new CustomEvent("notiq:open-sync-popover")); });
    await flush();
    expect(pop()).not.toBeNull();
    expect(invoke).toHaveBeenCalledWith("sync_devices", undefined);
    expect(pop()!.textContent).toContain("3 devices");
  });

  it("outside click closes", async () => {
    await render(<App />);
    await act(async () => openSyncPopover());
    expect(pop()).not.toBeNull();
    await mousedown(document.body);
    expect(pop()).toBeNull();
  });

  it("Sync now calls sync_now", async () => {
    await render(<App />);
    await act(async () => openSyncPopover());
    await click(q('[data-action="syncNow"]')!);
    await flush();
    expect(invoke).toHaveBeenCalledWith("sync_now", undefined);
  });

  it("Retry on a problem calls sync_now; Reconnect calls sync_connect", async () => {
    useSyncStore.setState({ status: status({ state: "error", lastError: "Drive is full" }) });
    await render(<App />);
    await act(async () => openSyncPopover());
    expect(pop()!.textContent).toContain("Drive is full");
    await click(q('[data-action="retry"]')!);
    await flush();
    expect(invoke).toHaveBeenCalledWith("sync_now", undefined);

    await act(async () => { useSyncStore.setState({ status: status({ state: "authNeeded" }) }); });
    await click(q('[data-action="reconnect"]')!);
    await flush();
    expect(invoke).toHaveBeenCalledWith("sync_connect", undefined);
  });

  it("not connected: Connect Google Drive calls sync_connect", async () => {
    useSyncStore.setState({ status: status({ provider: null, account: null, enabled: false, state: "off" }) });
    await render(<App />);
    expect(trigger().textContent).toBe("Sync off");
    await act(async () => openSyncPopover());
    expect(pop()!.textContent).toContain("Keep this vault on your other PCs");
    await click(q('[data-action="connect"]')!);
    await flush();
    expect(invoke).toHaveBeenCalledWith("sync_connect", undefined);
  });

  it("palette intent starts connecting as soon as it opens", async () => {
    useSyncStore.setState({ status: status({ provider: null, account: null, enabled: false, state: "off" }) });
    await render(<App />);
    await act(async () => openSyncPopover({ action: "connect" }));
    await flush();
    expect(invoke).toHaveBeenCalledWith("sync_connect", undefined);
  });

  it("Turn on sync unlocks first, then runs the shared enable flow", async () => {
    const ensureUnlocked = vi.fn(async () => true);
    useVaultStore.setState({ ensureUnlocked });
    useSyncStore.setState({ status: status({ enabled: false, state: "off" }) });
    await render(<App />);
    await act(async () => openSyncPopover());
    await click(q('[data-action="turnOn"]')!);
    await flush();
    expect(ensureUnlocked).toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("sync_enable", undefined);
    expect(pop()).toBeNull();
  });

  it("Sync settings opens the Settings sync row", async () => {
    const openSettings = vi.fn();
    useAppStore.setState({ openSettings });
    await render(<App />);
    await act(async () => openSyncPopover());
    await click(q('[data-action="settings"]')!);
    expect(openSettings).toHaveBeenCalledWith("vault", "vault.sync.status");
    expect(pop()).toBeNull();
  });

  it("locked: explains and offers Unlock", async () => {
    const ensureUnlocked = vi.fn(async () => true);
    useVaultStore.setState({ ensureUnlocked });
    useSyncStore.setState({ status: status({ state: "locked" }) });
    await render(<App />);
    await act(async () => openSyncPopover());
    expect(pop()!.textContent).toContain("resumes after you unlock");
    await click(q('[data-action="unlock"]')!);
    expect(ensureUnlocked).toHaveBeenCalled();
  });
});

describe("one-time indicator tip", () => {
  it("shows while pending, marks it shown, and goes away on Got it", async () => {
    localStorage.setItem(INDICATOR_TIP_KEY, "pending");
    await render(<SyncIndicator status={status()} vaultExists onOpen={() => {}} />);
    expect(q(".sync-tip")).not.toBeNull();
    expect(localStorage.getItem(INDICATOR_TIP_KEY)).toBe("shown");
    await click(q(".sync-tip__btn")!);
    expect(q(".sync-tip")).toBeNull();
  });

  it("stays hidden unless pending", async () => {
    await render(<SyncIndicator status={status()} vaultExists onOpen={() => {}} />);
    expect(q(".sync-tip")).toBeNull();
    localStorage.setItem(INDICATOR_TIP_KEY, "shown");
    await act(async () => { window.dispatchEvent(new Event("notiq:sync-indicator-tip")); });
    expect(q(".sync-tip")).toBeNull();
  });

  it("opening the popover dismisses it", async () => {
    localStorage.setItem(INDICATOR_TIP_KEY, "pending");
    await render(<SyncIndicator status={status()} vaultExists onOpen={() => {}} />);
    expect(q(".sync-tip")).not.toBeNull();
    await act(async () => { useSyncPopoverStore.setState({ open: true }); });
    expect(q(".sync-tip")).toBeNull();
  });
});
