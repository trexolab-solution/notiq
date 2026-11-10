// @vitest-environment happy-dom
/**
 * The approval sheet end to end (mocked Tauri): a stray Enter right after the window appears must never
 * fill (the focus starts on "Not now"); ↑ then Enter fills; Shift+Enter on Fill also copies the 2FA code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emptyLogin, serializeLogin } from "../lib/loginEntry";

const handlers = new Map<string, (e: { payload: unknown }) => void>();
const invoke = vi.fn();
const copySecretTimed = vi.fn(async () => 30);
const win = {
  setSize: vi.fn(async () => {}), center: vi.fn(async () => {}), setAlwaysOnTop: vi.fn(async () => {}),
  setFocus: vi.fn(async () => {}), setBackgroundColor: vi.fn(async () => {}),
};
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, h: (e: { payload: unknown }) => void) => { handlers.set(name, h); return () => handlers.delete(name); },
  emitTo: async () => {},
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => win,
  LogicalSize: class { constructor(public width: number, public height: number) {} },
}));
vi.mock("../hooks/useWindowContextMenu", () => ({ useWindowContextMenu: () => {} }));
vi.mock("../lib/secureCopy", async (orig) => ({
  ...(await orig<typeof import("../lib/secureCopy")>()),
  copySecretTimed: (...a: unknown[]) => copySecretTimed(...(a as [])),
}));

const { default: AutofillPromptApp } = await import("./AutofillPromptApp");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class { observe() {} disconnect() {} };
}

const ENTRIES = [
  { rel: "Logins/a.nqv", e: { ...emptyLogin("Example Bank"), url: "https://bank.example.com", username: "alex", password: "pw-a", totp: "JBSWY3DPEHPK3PXP" } },
  { rel: "Logins/b.nqv", e: { ...emptyLogin("Joint"), url: "https://bank.example.com", username: "sam", password: "pw-b" } },
];

let host: HTMLDivElement;
let root: Root;
const replies = () => invoke.mock.calls.filter((c) => c[0] === "autofill_reply").map((c) => (c[1] as { payload: unknown }).payload);
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };

beforeEach(async () => {
  handlers.clear();
  invoke.mockReset();
  copySecretTimed.mockClear();
  localStorage.setItem("pref:vaultDir", "C:/v");
  invoke.mockImplementation(async (cmd: string, a?: { path?: string }) => {
    switch (cmd) {
      case "vault_status": return { exists: true, unlocked: true };
      case "vault_list": return ENTRIES.map((x) => ({ rel: x.rel, ext: "login", updated: 1, dir: false, tags: [], starred: false, trashed_at: null, attachments: 0, history: 0 }));
      case "vault_read_file": {
        const x = ENTRIES.find((y) => a?.path?.endsWith(y.rel));
        if (!x) throw "Not found";
        return { ext: "login", content: serializeLogin(x.e) };
      }
      default: return null;
    }
  });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root.render(<AutofillPromptApp />); });
  await settle();
  await act(async () => { handlers.get("autofill:request")!({ payload: { id: "r1", host: "bank.example.com" } }); });
  await settle();
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; });

const press = async (k: string, o: KeyboardEventInit = {}) => {
  const el = document.activeElement as HTMLElement;
  await act(async () => {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o });
    el.dispatchEvent(ev);
    // A native button turns an unprevented Enter into a click.
    if (k === "Enter" && !ev.defaultPrevented && el.tagName === "BUTTON") el.click();
  });
  await settle();
};

describe("approval sheet: focus safety", () => {
  it("shows the sheet: title, host, one selected account, Fill and Not now", () => {
    expect(host.querySelector("#af-title")?.textContent).toBe("Sign in to Example Bank?");
    expect(host.querySelector(".af-hostline")?.hasAttribute("data-secure")).toBe(true);
    expect(host.querySelector('[role="alertdialog"]')?.getAttribute("aria-labelledby")).toBe("af-title");
    expect(host.querySelector(".af-acct-title")?.textContent).toBe("alex");
    expect(host.querySelector(".af-risk")).toBeNull(); // exact match: no warning
    expect(invoke).toHaveBeenCalledWith("autofill_prompt_show");
  });

  it("the focus starts on Not now: a stray Enter denies, nothing is filled", async () => {
    expect(document.activeElement?.textContent).toBe("Not now");
    await press("Enter");
    expect(replies()).toEqual([{ error: "denied" }]);
  });

  it("↑ moves to Fill; Enter there fills the selected login", async () => {
    await press("ArrowUp");
    expect(document.activeElement?.hasAttribute("data-af-fill")).toBe(true);
    await press("Enter");
    expect(replies()).toEqual([expect.objectContaining({ ok: true, username: "alex", password: "pw-a" })]);
    expect(copySecretTimed).not.toHaveBeenCalled();
  });

  it("Shift+Enter on Fill fills and copies the 2-step code", async () => {
    await press("ArrowUp");
    await press("Enter", { shiftKey: true });
    expect(replies()).toEqual([expect.objectContaining({ ok: true, username: "alex" })]);
    expect(copySecretTimed).toHaveBeenCalledWith(expect.stringMatching(/^\d{6}$/), expect.any(String), { quiet: true });
  });

  it("Escape is Not now", async () => {
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await settle();
    expect(replies()).toEqual([{ error: "denied" }]);
  });
});
