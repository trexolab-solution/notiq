// @vitest-environment happy-dom
/** NumberField: digits only, − / + and the arrow keys step it inside min..max, empty or out of range turns it red. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NumberField } from "./NumberField";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const seen = vi.fn();
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); seen.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

function Harness({ start, max = 100, min = 1, disabled }: { start: number; max?: number; min?: number; disabled?: boolean }) {
  const [v, set] = useState(start);
  return <NumberField label="Count" value={v} min={min} max={max} disabled={disabled} onChange={(n) => { seen(n); set(n); }} />;
}
const render = async (props: Parameters<typeof Harness>[0]) => { await act(async () => { root.render(<Harness {...props} />); }); };
const input = () => document.querySelector("input[aria-label=Count]") as HTMLInputElement;
const btn = (name: string) => document.querySelector(`button[aria-label="${name} Count"]`) as HTMLButtonElement;
const box = () => input().parentElement as HTMLElement;
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const key = async (k: string) => { await act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); }); };

describe("NumberField", () => {
  it("shows the number and is valid inside the range", async () => {
    await render({ start: 7 });
    expect(input().value).toBe("7");
    expect(input().getAttribute("aria-invalid")).toBeNull();
    expect(box().hasAttribute("data-invalid")).toBe(false);
  });

  it("takes digits only: anything else typed or pasted is dropped", async () => {
    await render({ start: 7 });
    await type("1a2-3.5e");
    expect(seen).toHaveBeenLastCalledWith(1235);
    await type("abc");
    expect(seen).toHaveBeenLastCalledWith(NaN);
    expect(input().value).toBe("");
  });

  it("is red when empty, when out of range, and says so to assistive tech", async () => {
    await render({ start: 7 });
    await type("");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(box().hasAttribute("data-invalid")).toBe(true);
    await type("101");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    await type("0");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    await type("100");
    expect(input().getAttribute("aria-invalid")).toBeNull();
  });

  it("steps with + and −, and stops at the ends", async () => {
    await render({ start: 99 });
    await act(async () => { btn("Increase").click(); });
    expect(input().value).toBe("100");
    expect(btn("Increase").disabled).toBe(true);
    await act(async () => { btn("Decrease").click(); });
    expect(input().value).toBe("99");
    await type("1");
    expect(btn("Decrease").disabled).toBe(true);
  });

  it("steps with the arrow keys", async () => {
    await render({ start: 5 });
    await key("ArrowUp");
    expect(input().value).toBe("6");
    await key("ArrowDown"); await key("ArrowDown");
    expect(input().value).toBe("4");
    await key("Enter");
    expect(input().value).toBe("4");
  });

  it("brings an out-of-range number back inside with the buttons, and starts an empty one at the minimum", async () => {
    await render({ start: 500 });
    await act(async () => { btn("Decrease").click(); });
    expect(input().value).toBe("100");
    await type("");
    await act(async () => { btn("Increase").click(); });
    expect(input().value).toBe("1");
  });

  it("can't be changed while disabled", async () => {
    await render({ start: 5, disabled: true });
    expect(input().disabled).toBe(true);
    expect(btn("Increase").disabled).toBe(true);
    expect(btn("Decrease").disabled).toBe(true);
  });
});
