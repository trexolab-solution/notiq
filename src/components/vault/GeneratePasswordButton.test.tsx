// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { GeneratePasswordButton } from "./GeneratePasswordButton";
import { setPwAsk } from "../../lib/vaultPrefs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setPwAsk(false); // "Remember my choice": Generate acts at once, no options popup
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); document.body.innerHTML = ""; localStorage.clear(); });

const buttonByText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === text);

async function typeWord(word: string) {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>("#confirm-word")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, word);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickGenerate(current: string | undefined, onGenerate: (p: string) => void) {
  await act(async () => { root.render(<GeneratePasswordButton current={current} onGenerate={onGenerate} />); });
  await act(async () => { buttonByText("Generate")!.click(); });
}

describe("Generate password: options popup", () => {
  it("opens in the page body, outside the form, and stays usable there", async () => {
    setPwAsk(true);
    const onGenerate = vi.fn();
    await act(async () => { root.render(<GeneratePasswordButton current="" onGenerate={onGenerate} />); });
    await act(async () => { buttonByText("Generate")!.click(); });
    const popup = document.querySelector('[role="dialog"][aria-label="Password generator options"]')!;
    expect(popup.parentElement).toBe(document.body);
    // A press inside the popup must not count as "outside" and close it.
    await act(async () => { popup.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(popup.isConnected).toBe(true);
    await act(async () => { [...popup.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Generate")!.click(); });
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("Generate password: confirm before replacing", () => {
  it("an empty field gets a password straight away", async () => {
    const onGenerate = vi.fn();
    await clickGenerate("", onGenerate);
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Replace the saved password?");
  });

  it("an existing password is only replaced after typing REPLACE", async () => {
    const onGenerate = vi.fn();
    await clickGenerate("old-secret", onGenerate);
    expect(onGenerate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Replace the saved password?");
    expect(buttonByText("Replace password")!.disabled).toBe(true);
    await typeWord("replace");
    expect(buttonByText("Replace password")!.disabled).toBe(true);
    await typeWord("REPLACE");
    await act(async () => { buttonByText("Replace password")!.click(); });
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0]).not.toBe("old-secret");
  });

  it("Cancel keeps the existing password", async () => {
    const onGenerate = vi.fn();
    await clickGenerate("old-secret", onGenerate);
    await act(async () => { buttonByText("Cancel")!.click(); });
    expect(onGenerate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Replace the saved password?");
  });
});
