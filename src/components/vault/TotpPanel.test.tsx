// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("../../lib/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock("../../lib/secureCopy", () => ({ copySecret: vi.fn(async () => true) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { TotpPanel } = await import("./TotpPanel");

let host: HTMLDivElement;
let root: Root;
const SECRET = "JBSWY3DPEHPK3PXP"; // RFC-style test key

async function render(secret: string, onChange = vi.fn()) {
  await act(async () => { root.render(<TotpPanel secret={secret} onChange={onChange} />); });
  await act(async () => { await Promise.resolve(); });
  return onChange;
}

/** The code comes from an async hash, so on a slow machine it appears a few ticks after the first render. */
async function codeShown(): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if (host.querySelector("[data-testid=\"totp-code\"]")) return true;
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  }
  return false;
}
const input = () => host.querySelector<HTMLInputElement>("#le-totp")!;

beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("TotpPanel", () => {
  it("hides the setup key by default and shows it on request", async () => {
    await render(SECRET);
    expect(input().type).toBe("password");
    const reveal = host.querySelector<HTMLButtonElement>('button[aria-label="Show setup key"]')!;
    await act(async () => { reveal.click(); });
    expect(input().type).toBe("text");
    expect(host.querySelector('button[aria-label="Hide setup key"]')).toBeTruthy();
  });

  it("shows the live code and its countdown for a valid key", async () => {
    await render(SECRET);
    expect(await codeShown()).toBe(true);
    const code = host.querySelector('[data-testid="totp-code"]')!.textContent!;
    expect(code).toMatch(/^\d{3} \d{3}$/);
    expect(host.querySelector('[data-testid="totp-left"]')!.textContent).toMatch(/^\d+s$/);
  });

  it("says so for a key that is not valid, and shows no code", async () => {
    await render("not a key!!");
    expect(host.textContent).toContain("doesn't look like a valid setup key");
    expect(host.querySelector('[data-testid="totp-code"]')).toBeNull();
  });

  it("shows nothing but the field when there is no key", async () => {
    await render("");
    expect(host.querySelector('[data-testid="totp-code"]')).toBeNull();
    expect(host.textContent).not.toContain("valid setup key");
  });
});
