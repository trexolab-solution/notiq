// @vitest-environment happy-dom
/** TimeLimitField: when (a set time / never), a number and hours or days, in one group; a wrong number says why. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TimeLimitField } from "./TimeLimitField";
import type { TimeLimit } from "../../lib/shareExport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let latest: TimeLimit;
beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); document.body.innerHTML = ""; });

function Harness({ start }: { start: TimeLimit }) {
  const [v, set] = useState(start);
  latest = v;
  return <TimeLimitField label="File expiry" what="File expiry" hint="After this, the file can't be imported." value={v} onChange={set} onLabel="After a set time" offLabel="Never" />;
}
const render = async (start: TimeLimit) => { await act(async () => { root.render(<Harness start={start} />); }); };
const amount = () => document.querySelector("input[aria-label='File expiry: amount']") as HTMLInputElement | null;
const trigger = (what: string) => document.querySelector(`button[aria-label="File expiry: ${what}"]`) as HTMLButtonElement;
async function pick(what: string, text: string) {
  await act(async () => { trigger(what).click(); });
  const option = Array.from(document.querySelectorAll("[role=option]")).find((o) => o.textContent === text) as HTMLElement;
  await act(async () => { option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(amount(), value);
    amount()!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("TimeLimitField", () => {
  it("is one group: when, number, unit, with the hint under it", async () => {
    await render({ on: true, amount: 7, unit: "days" });
    const group = document.querySelector("[data-time-group]")!;
    expect(group.contains(trigger("when"))).toBe(true);
    expect(group.contains(amount())).toBe(true);
    expect(group.contains(trigger("unit"))).toBe(true);
    expect(trigger("when").textContent).toContain("After a set time");
    expect(trigger("unit").textContent).toContain("days");
    expect(document.body.textContent).toContain("After this, the file can't be imported.");
    expect(group.hasAttribute("data-invalid")).toBe(false);
  });

  it("turns the number and the unit away when it is set to Never", async () => {
    await render({ on: true, amount: 7, unit: "days" });
    await pick("when", "Never");
    expect(latest.on).toBe(false);
    expect(amount()).toBeNull();
    expect(trigger("unit")).toBeNull();
    await pick("when", "After a set time");
    expect(amount()!.value).toBe("7");
  });

  it("sets hours or days", async () => {
    await render({ on: true, amount: 7, unit: "days" });
    await type("36");
    await pick("unit", "hours");
    expect(latest).toEqual({ on: true, amount: 36, unit: "hours" });
  });

  it("a number outside 1 to a year turns the group red and says why, instead of the hint", async () => {
    await render({ on: true, amount: 7, unit: "days" });
    await type("400");
    expect(document.querySelector("[data-time-group]")!.hasAttribute("data-invalid")).toBe(true);
    expect(document.querySelector("[role=alert]")!.textContent).toBe("File expiry: enter 1 to 365 days.");
    expect(document.body.textContent).not.toContain("After this, the file can't be imported.");
    await pick("unit", "hours"); // 400 hours is fine
    expect(document.querySelector("[role=alert]")).toBeNull();
    expect(document.body.textContent).toContain("After this, the file can't be imported.");
    await type("9000");
    expect(document.querySelector("[role=alert]")!.textContent).toBe("File expiry: enter 1 to 8760 hours.");
    await type("");
    expect(document.querySelector("[role=alert]")).toBeTruthy();
  });
});
