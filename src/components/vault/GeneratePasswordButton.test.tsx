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

async function clickGenerate(current: string | undefined, onGenerate: (p: string) => void) {
  await act(async () => { root.render(<GeneratePasswordButton current={current} onGenerate={onGenerate} />); });
  await act(async () => { buttonByText("Generate")!.click(); });
}

describe("Generate password: confirm before replacing", () => {
  it("an empty field gets a password straight away", async () => {
    const onGenerate = vi.fn();
    await clickGenerate("", onGenerate);
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Replace the password?");
  });

  it("an existing password is only replaced after confirming", async () => {
    const onGenerate = vi.fn();
    await clickGenerate("old-secret", onGenerate);
    expect(onGenerate).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Replace the password?");
    await act(async () => { buttonByText("Replace password")!.click(); });
    expect(onGenerate).toHaveBeenCalledTimes(1);
    expect(onGenerate.mock.calls[0][0]).not.toBe("old-secret");
  });

  it("Cancel keeps the existing password", async () => {
    const onGenerate = vi.fn();
    await clickGenerate("old-secret", onGenerate);
    await act(async () => { buttonByText("Cancel")!.click(); });
    expect(onGenerate).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Replace the password?");
  });
});
