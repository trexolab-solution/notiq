// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SshAuthChoiceDialog } from "./SshAuthChoiceDialog";
import { getAuthPreference, preferredAuth } from "../../lib/sshPreferredAuth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; localStorage.clear(); });

const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="group"][aria-label="Sign-in method"] button')];
const focused = () => options().indexOf(document.activeElement as HTMLButtonElement);
const press = async (key: string) => {
  await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
};

async function render(extra: Partial<Parameters<typeof SshAuthChoiceDialog>[0]> = {}) {
  const onPick = vi.fn();
  await act(async () => { root.render(<SshAuthChoiceDialog name="VPS" label="a@b" onPick={onPick} onClose={() => {}} {...extra} />); });
  return onPick;
}

describe("SSH sign-in choice", () => {
  it("has no Cancel button, and starts on the first option", async () => {
    await render();
    expect(document.body.textContent).not.toContain("Cancel");
    expect(focused()).toBe(0);
  });

  it("moves with the arrows, Home and End, wrapping around", async () => {
    await render();
    await press("ArrowDown"); expect(focused()).toBe(1);
    await press("ArrowDown"); expect(focused()).toBe(0);
    await press("ArrowUp"); expect(focused()).toBe(1);
    await press("Home"); expect(focused()).toBe(0);
    await press("End"); expect(focused()).toBe(1);
  });

  it("picks with 1 and 2", async () => {
    const onPick = await render();
    await press("2");
    expect(onPick).toHaveBeenLastCalledWith("password");
    await press("1");
    expect(onPick).toHaveBeenLastCalledWith("key");
  });

  it("saves the pick as the preference only when asked to, and offers the way to change it later", async () => {
    const onPick = await render({ entryKey: "C:/vault/a.nqv" });
    await press("2");
    expect(getAuthPreference("C:/vault/a.nqv")).toBe("ask");
    await act(async () => { document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(); });
    await act(async () => { options()[0].click(); });
    expect(onPick).toHaveBeenLastCalledWith("key");
    expect(getAuthPreference("C:/vault/a.nqv")).toBe("key");
    expect(document.body.textContent).toContain("under Sign in");
    expect(preferredAuth("C:/vault/a.nqv", ["key", "password"])).toBe("key");
    expect(preferredAuth("C:/vault/b.nqv", ["key", "password"])).toBeNull();
    expect(preferredAuth("C:/vault/b.nqv", ["password"])).toBe("password");
  });

  it("offers no preference for a server that isn't a saved entry", async () => {
    await render();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it("keeps a Back button only when there is a step to go back to", async () => {
    const onBack = vi.fn();
    await render({ onBack });
    const back = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Back")!;
    await act(async () => { back.click(); });
    expect(onBack).toHaveBeenCalled();
  });
});
