// @vitest-environment happy-dom
/** TimeLimitField: how (after a set time / on a date and time / never) and what that needs, in one group; errors say why. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TimeLimitField } from "./TimeLimitField";
import type { TimeLimit } from "../../lib/shareExport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 24, 12, 0).getTime();
const HOUR = 3_600_000;
let host: HTMLDivElement;
let root: Root;
let latest: TimeLimit;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 100, top: 100, right: 400, bottom: 136, width: 300, height: 36, x: 100, y: 100 } as DOMRect));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.useRealTimers(); });

const after = (n: number, unit: "hours" | "days" = "days"): TimeLimit => ({ mode: "after", amount: n, unit, at: null });

function Harness({ start }: { start: TimeLimit }) {
  const [v, set] = useState(start);
  latest = v;
  return <TimeLimitField label="File expiry" what="File expiry" hint="After this, the file can't be imported." value={v} onChange={set} />;
}
const render = async (start: TimeLimit) => { await act(async () => { root.render(<Harness key={JSON.stringify(start)} start={start} />); }); };
const amount = () => document.querySelector("input[aria-label='File expiry: amount']") as HTMLInputElement | null;
const trigger = (what: string) => document.querySelector(`button[aria-label="File expiry: ${what}"]`) as HTMLButtonElement | null;
async function pick(what: string, text: string) {
  await act(async () => { trigger(what)!.click(); });
  const option = Array.from(document.querySelectorAll("[role=option]")).find((o) => o.textContent === text) as HTMLElement;
  await act(async () => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(amount(), value);
    amount()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const group = () => document.querySelector("[data-time-group]")!;

describe("TimeLimitField", () => {
  it("is one group: how, number, unit, with the hint under it", async () => {
    await render(after(7));
    expect(group().contains(trigger("when"))).toBe(true);
    expect(group().contains(amount())).toBe(true);
    expect(group().contains(trigger("unit"))).toBe(true);
    expect(trigger("when")!.textContent).toContain("After a set time");
    expect(trigger("unit")!.textContent).toContain("days");
    expect(document.body.textContent).toContain("After this, the file can't be imported.");
    expect(group().hasAttribute("data-invalid")).toBe(false);
  });

  it("offers a set time, a date and time, or never", async () => {
    await render(after(7));
    await act(async () => { trigger("when")!.click(); });
    expect(Array.from(document.querySelectorAll("[role=option]")).map((o) => o.textContent)).toEqual(["After a set time", "On a date and time", "Never"]);
  });

  it("Never takes the number and the unit away", async () => {
    await render(after(7));
    await pick("when", "Never");
    expect(latest.mode).toBe("never");
    expect(amount()).toBeNull();
    expect(trigger("unit")).toBeNull();
    await pick("when", "After a set time");
    expect(amount()!.value).toBe("7");
  });

  it("sets hours or days", async () => {
    await render(after(7));
    await type("36");
    await pick("unit", "hours");
    expect(latest).toMatchObject({ mode: "after", amount: 36, unit: "hours" });
  });

  it("a number outside 1 to a year turns the group red and says why, instead of the hint", async () => {
    await render(after(7));
    await type("400");
    expect(group().hasAttribute("data-invalid")).toBe(true);
    expect(document.querySelector("[role=alert]")!.textContent).toBe("File expiry: enter 1 to 365 days.");
    expect(document.body.textContent).not.toContain("After this, the file can't be imported.");
    await pick("unit", "hours");
    expect(document.querySelector("[role=alert]")).toBeNull();
    await type("9000");
    expect(document.querySelector("[role=alert]")!.textContent).toBe("File expiry: enter 1 to 8760 hours.");
    await type("");
    expect(document.querySelector("[role=alert]")).toBeTruthy();
  });

  it("On a date and time swaps the number and unit for a date and time field, starting at the next full hour", async () => {
    await render(after(7));
    await pick("when", "On a date and time");
    expect(latest.mode).toBe("at");
    expect(latest.at).toBe(new Date(2026, 10, 24, 13, 0).getTime());
    expect(amount()).toBeNull();
    const field = document.querySelector("button[aria-label='File expiry: date and time']") as HTMLButtonElement;
    expect(group().contains(field)).toBe(true);
    expect(field.textContent).toMatch(/Nov.*2026.*1:00/);
    expect(group().hasAttribute("data-invalid")).toBe(false);
  });

  it("a date and time that has passed, or none, turns the group red", async () => {
    await render({ mode: "at", amount: 7, unit: "days", at: NOW - HOUR });
    expect(group().hasAttribute("data-invalid")).toBe(true);
    expect(document.querySelector("[role=alert]")!.textContent).toBe("File expiry: choose a time that is still ahead.");
    await render({ mode: "at", amount: 7, unit: "days", at: null });
    expect(document.querySelector("[role=alert]")!.textContent).toBe("File expiry: pick a date and time.");
    await render({ mode: "at", amount: 7, unit: "days", at: NOW + 4 * HOUR });
    expect(document.querySelector("[role=alert]")).toBeNull();
  });

  it("choosing a day in the calendar sets the moment", async () => {
    await render({ mode: "at", amount: 7, unit: "days", at: new Date(2026, 10, 24, 16, 0).getTime() });
    await act(async () => { (document.querySelector("button[aria-label='File expiry: date and time']") as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector("button[data-day='27']") as HTMLButtonElement).click(); });
    expect(latest.at).toBe(new Date(2026, 10, 27, 16, 0).getTime());
  });
});
