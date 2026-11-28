// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ED25519_PRIV } from "../../lib/__fixtures__/sshKeys";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const hiddenHandlers: (() => void)[] = [];
let windowOnScreen = true;
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ isVisible: async () => windowOnScreen }) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: () => void) => { if (name === "vault-window-hidden") hiddenHandlers.push(cb); return () => {}; },
}));
vi.mock("../../lib/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ServerOverview, POLL_MS, AUTO_DELAY_MS, clearHeldOverviews } = await import("./ServerOverview");
const { KEEPALIVE_MS } = await import("../../lib/overviewKeepAlive");
const FIRST_REREAD = POLL_MS;
const { useAppStore } = await import("../../store");
const { useVaultStore } = await import("../../store/vaultStore");
type Tab = import("../../types").Tab;
type Reading = import("../../lib/serverOverview").ServerReading;
type AuthPreference = import("../../lib/sshPreferredAuth").AuthPreference;

const PATH = "C:/vault/SSH/Prod.nqv";
const PASSWORD_ONLY = { host: "srv.example.com", username: "root", password: "s3cret-pw" };
const BOTH = { ...PASSWORD_ONLY, privateKey: ED25519_PRIV };
const makeTab = (over: Partial<Tab> = {}) => ({ id: "t1", title: "Prod.nqv", filePath: PATH, content: "", isDirty: false, vaultExt: "ssh", ...over } as unknown as Tab);

const reading = (over: Partial<Reading> = {}): Reading => ({
  supported: true, system: "Linux", hostname: "web-01", os: "Ubuntu 24.04.1 LTS", kernel: "6.8.0", arch: "x86_64",
  cpuModel: "AMD EPYC", uptimeSecs: 93784, cores: 4, cpuPercent: 23.4, load: [0.52, 0.61, 0.7],
  memory: { total: 2 * 1024 ** 3, used: 1024 ** 3, available: 1024 ** 3, cached: 512 * 1024 ** 2 },
  swap: { total: 1024 ** 3, used: 256 * 1024 ** 2 },
  disks: [{ mount: "/", device: "/dev/sda1", fsType: "ext4", total: 40 * 1024 ** 3, used: 37 * 1024 ** 3, available: 3 * 1024 ** 3 }],
  disksMore: 0, ...over,
});

let host: HTMLDivElement;
let root: Root;
let panel: HTMLDivElement;
let fields: Record<string, string> = PASSWORD_ONLY;
let pref: AuthPreference = "ask";
const flush = (ms = 20) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const byText = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim().startsWith(text)) ?? null;
const click = async (el: Element | null) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

function Host() {
  const tab = useAppStore((s) => s.tabs[0]);
  return <ServerOverview tab={tab} name="Prod" fields={fields} pref={pref} />;
}

async function render(tab = makeTab()) {
  useAppStore.setState({ tabs: [tab], activeTabId: "t1" });
  await act(async () => { root.render(<Host />); });
  await flush();
}

/** Backend that answers every poll with `next()`. */
function backend(next: () => Reading | Promise<Reading> = () => reading(), open: (args: Record<string, unknown>) => void = () => {}) {
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "server_overview_open") return open(args);
    if (cmd === "server_overview_poll") return next();
    return null;
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  windowOnScreen = true;
  localStorage.clear();
  backend();
  clearHeldOverviews(); // after backend(): closing a kept session calls it
  invoke.mockClear(); // that close belongs to the test before
  fields = PASSWORD_ONLY;
  pref = "ask";
  useVaultStore.setState({ unlocked: true });
  panel = document.createElement("div");
  panel.dataset.panel = "overview";
  host = document.createElement("div");
  host.className = "@container";
  panel.appendChild(host);
  document.body.appendChild(panel);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  panel.remove();
  vi.useRealTimers();
});

describe("ServerOverview", () => {
  it("connects by itself once it has been in view for a moment, with a skeleton until the first reading", async () => {
    let release: (r: Reading) => void = () => {};
    backend(() => new Promise<Reading>((r) => { release = r; }));
    await render();
    expect(q("[data-overview-skeleton]")).toBeTruthy();
    expect(calls("server_overview_open")).toHaveLength(0);
    await flush(AUTO_DELAY_MS);
    expect(calls("server_overview_open")[0][1]).toMatchObject({ auth: "password", trust: null });
    expect(q("[data-overview-skeleton]")).toBeTruthy();
    expect(q("[data-overview-idle]")).toBeNull();
    await act(async () => { release(reading()); });
    expect(q("[data-overview]")).toBeTruthy();
    expect(q("[data-overview-skeleton]")).toBeNull();
  });

  it("opens nothing for an entry that is only flipped past", async () => {
    await render();
    await flush(AUTO_DELAY_MS / 2);
    await act(async () => { useAppStore.setState({ activeTabId: "other" }); });
    await flush(10_000);
    expect(calls("server_overview_open")).toHaveLength(0);
  });

  it("with two methods saved, waits for the first choice and then uses the last one by itself", async () => {
    fields = BOTH;
    await render();
    await flush(10_000);
    expect(invoke).not.toHaveBeenCalled();
    expect(q("[data-overview-idle]")?.textContent).toContain("See how root@srv.example.com is doing");
    localStorage.setItem("pref:sshLastAuth", JSON.stringify({ [PATH.toLowerCase()]: "password" }));
    act(() => root.unmount());
    root = createRoot(host);
    await render();
    await flush(AUTO_DELAY_MS);
    expect(calls("server_overview_open")[0][1]).toMatchObject({ auth: "password" });
  });

  it("after a failed sign-in, doesn't try again by itself (until the entry is changed)", async () => {
    backend(undefined, () => { throw "Permission denied (password) for root."; });
    const reopen = async () => {
      act(() => root.unmount());
      root = createRoot(host);
      await render();
      await flush(AUTO_DELAY_MS * 3);
    };
    await render();
    await flush(AUTO_DELAY_MS * 3);
    await reopen();
    expect(calls("server_overview_open")).toHaveLength(1);

    backend();
    await act(async () => { useAppStore.setState({ tabs: [makeTab({ isDirty: true })] }); });
    await flush();
    await act(async () => { useAppStore.setState({ tabs: [makeTab()] }); });
    await flush(AUTO_DELAY_MS);
    expect(calls("server_overview_open")).toHaveLength(2);
    // There is no button to disconnect: leaving the section does that.
    expect(byText("Disconnect")).toBeNull();
  });

  it("remembers a sign-in that failed after you left, and starts no second one beside it", async () => {
    let fail: (e: string) => void = () => {};
    invoke.mockImplementation(async (cmd: string) => (cmd === "server_overview_open"
      ? new Promise<void>((_, reject) => { fail = reject; }) : null));
    await render();
    await flush(AUTO_DELAY_MS);
    await act(async () => { useAppStore.setState({ activeTabId: "other" }); });
    await act(async () => { useAppStore.setState({ activeTabId: "t1" }); });
    await flush(AUTO_DELAY_MS * 3);
    expect(calls("server_overview_open")).toHaveLength(1);
    await act(async () => { fail("Permission denied (password) for root."); });
    await flush(AUTO_DELAY_MS * 3);
    await act(async () => { useAppStore.setState({ activeTabId: "other" }); });
    await act(async () => { useAppStore.setState({ activeTabId: "t1" }); });
    await flush(AUTO_DELAY_MS * 3);
    expect(calls("server_overview_open")).toHaveLength(1);
    expect(byText("Try again")).toBeTruthy(); // the sign-in went on while away, and its failure is shown
  });

  it("doesn't connect by itself while the window is not on screen, even if the page isn't told", async () => {
    windowOnScreen = false;
    await render();
    await flush(AUTO_DELAY_MS * 5);
    expect(calls("server_overview_open")).toHaveLength(0);
    windowOnScreen = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flush(AUTO_DELAY_MS);
    expect(calls("server_overview_open")).toHaveLength(1);
  });

  it("keeps the server's details behind the i button, in a popover that Escape closes", async () => {
    await render();
    await flush(AUTO_DELAY_MS);
    expect(document.body.textContent).not.toContain("web-01");
    await click(q('button[aria-label="Server details"]'));
    const pop = q('[role="dialog"][aria-label="Server details"]')!;
    for (const text of ["web-01", "Ubuntu 24.04.1 LTS", "6.8.0 · x86_64", "1 day, 2 hours", "AMD EPYC"]) expect(pop.textContent).toContain(text);
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(q("[data-server-details]")).toBeNull();
    await click(q('button[aria-label="Server details"]'));
    await act(async () => { useAppStore.setState({ activeTabId: "other" }); });
    await flush();
    expect(q("[data-server-details]")).toBeNull();
  });

  it("connects with only the entry's path and method, then shows the readings with text for every graph", async () => {
    await render();
    await flush(AUTO_DELAY_MS);
    const open = calls("server_overview_open")[0][1] as Record<string, unknown>;
    expect(open).toMatchObject({ path: PATH, auth: "password", trust: null });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("s3cret-pw");
    expect(q("[data-overview]")).toBeTruthy();
    expect(document.body.textContent).toContain("23%");
    // Bars carry their value as text; a nearly full disk is flagged.
    const disk = q('[role="meter"][aria-label="Disk /"]')!;
    expect(disk.getAttribute("aria-valuenow")).toBe("93");
    expect(disk.getAttribute("aria-valuetext")).toContain("37 GB of 40 GB used");
    expect(q('[role="meter"][aria-label="Memory"]')!.getAttribute("aria-valuenow")).toBe("50");
    // A second reading draws the graphs, each with a sentence for screen readers.
    await flush(POLL_MS);
    expect(calls("server_overview_poll")).toHaveLength(2);
    const graphs = [...document.querySelectorAll('svg[role="img"]')].map((g) => g.getAttribute("aria-label"));
    expect(graphs).toEqual([
      "CPU usage over the last 2 readings: now 23%, lowest 23%, highest 23%",
      "Memory usage over the last 2 readings: now 50%, lowest 50%, highest 50%",
    ]);
    expect(q("[data-overview-status]")?.textContent).toContain("Live");
  });

  it("shows server text as plain text only", async () => {
    backend(() => reading({ hostname: "<img src=x onerror=alert(1)>", os: "<b>bold</b>" }));
    await render();
    await flush(AUTO_DELAY_MS);
    await click(q('button[aria-label="Server details"]'));
    expect(document.body.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(q("[data-overview] img")).toBeNull();
    expect(q("[data-overview] b")).toBeNull();
    expect(q("[data-server-details] img, [data-server-details] b")).toBeNull();
  });

  it("asks before trusting a new server, and sends the approved key back", async () => {
    const key = { host: "srv.example.com", port: 22, alg: "ssh-ed25519", fp: "SHA256:abc" };
    let first = true;
    backend(undefined, () => { if (first) { first = false; throw `unknown_host:${JSON.stringify(key)}`; } });
    await render();
    await flush(AUTO_DELAY_MS);
    expect(q('[role="alertdialog"]')?.textContent).toContain("SHA256:abc");
    expect(calls("server_overview_poll")).toHaveLength(0);
    expect(document.body.textContent).not.toContain("unknown_host");
    await click(byText("Trust and connect"));
    expect(calls("server_overview_open")[1][1]).toMatchObject({ trust: key });
    expect(q("[data-overview]")).toBeTruthy();
  });

  it("refusing the key sends nothing and says so", async () => {
    backend(undefined, () => { throw `unknown_host:${JSON.stringify({ host: "h", port: 22, alg: "ssh-ed25519", fp: "SHA256:x" })}`; });
    await render();
    await flush(AUTO_DELAY_MS);
    await click(byText("Don't trust"));
    expect(q('[role="alert"]')?.textContent).toContain("You didn't trust this server's key");
    expect(calls("server_overview_open")).toHaveLength(1);
  });

  it("asks which method to use when both are saved, or uses the preference", async () => {
    fields = BOTH;
    await render();
    await click(byText("Connect"));
    expect(q('[role="dialog"]')).toBeTruthy();
    expect(calls("server_overview_open")).toHaveLength(0);
    act(() => root.unmount());
    root = createRoot(host);
    pref = "key";
    await render();
    await flush(AUTO_DELAY_MS);
    expect(calls("server_overview_open")[0][1]).toMatchObject({ auth: "key" });
  });

  it("polls one at a time", async () => {
    let release: (r: Reading) => void = () => {};
    backend(() => new Promise<Reading>((r) => { release = r; }));
    await render();
    await flush(AUTO_DELAY_MS);
    await flush(POLL_MS * 5);
    expect(calls("server_overview_poll")).toHaveLength(1);
    await act(async () => { release(reading()); });
    await flush(POLL_MS);
    expect(calls("server_overview_poll")).toHaveLength(2);
  });

  it("stays connected while the section is hidden, reading only now and then", async () => {
    await render();
    await flush(AUTO_DELAY_MS);
    await flush(FIRST_REREAD);
    await act(async () => { panel.hidden = true; });
    await flush();
    const polls = calls("server_overview_poll").length;
    await flush(POLL_MS * 4);
    expect(calls("server_overview_poll")).toHaveLength(polls);
    await flush(KEEPALIVE_MS);
    expect(calls("server_overview_poll")).toHaveLength(polls + 1);
    await act(async () => { panel.hidden = false; });
    await flush();
    expect(calls("server_overview_poll")).toHaveLength(polls + 2);
    expect(calls("server_overview_open")).toHaveLength(1);
    expect(calls("server_overview_close")).toHaveLength(0);
  });

  /** The form goes away (another tab is shown) and a new one comes. */
  const leave = () => { act(() => root.unmount()); root = createRoot(host); };

  it("keeps the connection when the form goes away, and takes it back without signing in again", async () => {
    await render();
    await flush(AUTO_DELAY_MS);
    leave();
    await flush();
    const polls = calls("server_overview_poll").length;
    await flush(KEEPALIVE_MS);
    expect(calls("server_overview_poll")).toHaveLength(polls + 1);
    await render();
    await flush(AUTO_DELAY_MS * 3);
    expect(q("[data-overview]")).toBeTruthy();
    expect(q("[data-overview-status]")?.textContent).toContain("Live");
    expect(calls("server_overview_open")).toHaveLength(1);
    expect(calls("server_overview_close")).toHaveLength(0);
  });

  it.each([
    ["the tab closes", () => { useAppStore.setState({ tabs: [] }); }],
    ["the vault locks", () => { useVaultStore.setState({ unlocked: false }); }],
    ["the entry changes", () => { useAppStore.setState({ tabs: [makeTab({ content: "changed" })] }); }],
  ])("closes a connection kept for a form that is away when %s", async (_what, happen) => {
    await render();
    await flush(AUTO_DELAY_MS);
    leave();
    await flush();
    expect(calls("server_overview_close")).toHaveLength(0);
    await act(async () => { happen(); });
    expect(calls("server_overview_close")).toHaveLength(1);
    const polls = calls("server_overview_poll").length;
    await flush(KEEPALIVE_MS * 2);
    expect(calls("server_overview_poll")).toHaveLength(polls);
  });

  it("closes and forgets the readings when the vault locks", async () => {
    await render();
    await flush(AUTO_DELAY_MS);
    expect(q("[data-overview]")).toBeTruthy();
    await act(async () => { useVaultStore.setState({ unlocked: false }); });
    await flush(POLL_MS * 2);
    expect(calls("server_overview_close")).toHaveLength(1);
    expect(q("[data-overview]")).toBeNull();
    expect(byText("Connect")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Unlock the vault first.");
  });

  it("closes when Notiq is hidden to the tray, even if the page isn't told it is hidden", async () => {
    hiddenHandlers.length = 0;
    await render();
    await flush(AUTO_DELAY_MS);
    await act(async () => { hiddenHandlers.forEach((h) => h()); });
    await flush(POLL_MS * 3);
    expect(calls("server_overview_close")).toHaveLength(1);
    const polls = calls("server_overview_poll").length;
    await flush(POLL_MS * 3);
    expect(calls("server_overview_poll")).toHaveLength(polls);
    expect(document.body.textContent).toContain("Disconnected when Notiq was hidden.");
    expect(calls("server_overview_open")).toHaveLength(1);
    // Back on screen: it picks up again.
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await flush(AUTO_DELAY_MS);
    expect(calls("server_overview_open")).toHaveLength(2);
  });

  it("is only for a saved, unchanged entry", async () => {
    await render(makeTab({ isDirty: true }));
    expect(byText("Connect")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Save this entry first (Ctrl+S)");
    // Editing while connected stops it.
    await act(async () => { useAppStore.setState({ tabs: [makeTab()] }); });
    await flush(AUTO_DELAY_MS);
    await act(async () => { useAppStore.setState({ tabs: [makeTab({ isDirty: true })] }); });
    await flush();
    expect(calls("server_overview_close")).toHaveLength(1);
  });

  it("says a non-Linux server isn't supported instead of showing numbers", async () => {
    backend(() => reading({ supported: false, system: "FreeBSD", memory: null, disks: [] }));
    await render();
    await flush(AUTO_DELAY_MS);
    expect(q("[data-overview-unsupported]")?.textContent).toContain("“FreeBSD”");
    expect(q("[data-overview]")).toBeNull();
    expect(calls("server_overview_close")).toHaveLength(1);
    await flush(POLL_MS * 3);
    expect(calls("server_overview_poll")).toHaveLength(1);
  });

  it("shows why it couldn't connect, with a way to try again", async () => {
    let fail = true;
    backend(undefined, () => { if (fail) throw "Permission denied (password) for root."; });
    await render();
    await flush(AUTO_DELAY_MS);
    expect(q('[role="alert"]')?.textContent).toContain("Permission denied");
    fail = false;
    await click(byText("Try again"));
    expect(q("[data-overview]")).toBeTruthy();
  });

  it("keeps the last reading when the connection drops", async () => {
    let n = 0;
    backend(() => { if (++n > 1) throw "The connection to the server was closed. Connect again to continue."; return reading(); });
    await render();
    await flush(AUTO_DELAY_MS);
    await flush(POLL_MS);
    expect(q("[data-overview]")?.className).toContain("opacity-60");
    expect(q('[role="alert"]')?.textContent).toContain("connection to the server was closed");
    expect(byText("Try again")).toBeTruthy();
  });
});
