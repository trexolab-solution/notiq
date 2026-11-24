// @vitest-environment happy-dom
/** DateTimePicker: a calendar and a time of its own; days outside the range can't be chosen; the time zone is said. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DateTimePicker } from "./DateTimePicker";
import { decompose } from "../../lib/dateTime";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 10, 24, 12, 0).getTime();
const DAY = 86_400_000;
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime();

let host: HTMLDivElement;
let root: Root;
let latest: number | null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ left: 100, top: 100, right: 400, bottom: 136, width: 300, height: 36, x: 100, y: 100 } as DOMRect));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Harness({ start }: { start: number | null; k?: string }) {
  const [v, set] = useState(start);
  latest = v;
  return <DateTimePicker label="When" value={v} min={NOW} max={NOW + 365 * DAY} onChange={set} />;
}
const render = async (start: number | null = null) => { await act(async () => { root.render(<Harness key={String(start)} start={start} />); }); };
const trigger = () => document.querySelector("button[aria-label=When]") as HTMLButtonElement;
const panel = () => document.querySelector("[data-datetime-panel]") as HTMLElement | null;
const open = async () => { await act(async () => { trigger().click(); }); };
const day = (n: number) => document.querySelector(`button[data-day="${n}"]`) as HTMLButtonElement;
const q = (sel: string) => document.querySelector(sel) as HTMLElement;
async function type(label: string, value: string) {
  const input = document.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("DateTimePicker", () => {
  it("shows a placeholder until something is picked, then the moment", async () => {
    await render();
    expect(trigger().textContent).toContain("Pick a date and time");
    await render(at(2026, 11, 1, 16, 0));
    expect(trigger().textContent).toMatch(/Dec.*2026.*4:00/);
    expect(panel()).toBeNull();
  });

  it("opens a calendar on the month of the value, with the days, a time and the time zone", async () => {
    await render(at(2026, 11, 1, 16, 5));
    await open();
    expect(panel()).toBeTruthy();
    expect(q("[data-month-label]").textContent).toBe("December 2026");
    expect(document.querySelectorAll("button[data-day]")).toHaveLength(31);
    expect(day(1).getAttribute("aria-pressed")).toBe("true");
    expect((q("input[aria-label='When: hour']") as HTMLInputElement).value).toBe("4");
    expect((q("input[aria-label='When: minutes']") as HTMLInputElement).value).toBe("05");
    expect(q("[role=radio][aria-checked=true]").textContent).toBe("PM");
    expect(panel()!.textContent).toMatch(/In your time zone.*The receiver sees it in theirs\./);
  });

  it("with nothing chosen it opens on this month, at the time it would suggest", async () => {
    await render();
    await open();
    expect(q("[data-month-label]").textContent).toBe("November 2026");
    expect((q("input[aria-label='When: hour']") as HTMLInputElement).value).toBe("1");
    expect(q("[role=radio][aria-checked=true]").textContent).toBe("PM");
  });

  it("picks a day, keeping the time", async () => {
    await render(at(2026, 11, 1, 16, 5));
    await open();
    await act(async () => { day(9).click(); });
    expect(decompose(latest!)).toMatchObject({ year: 2026, month: 11, day: 9, hour12: 4, minute: 5, pm: true });
  });

  it("changes the time: hour, minutes and AM / PM", async () => {
    await render(at(2026, 11, 1, 16, 0));
    await open();
    await type("When: hour", "9");
    expect(decompose(latest!)).toMatchObject({ day: 1, hour12: 9, minute: 0, pm: true });
    await type("When: minutes", "45");
    expect(decompose(latest!)).toMatchObject({ hour12: 9, minute: 45 });
    await act(async () => { (document.querySelectorAll("[role=radio]")[0] as HTMLElement).click(); });
    expect(decompose(latest!)).toMatchObject({ hour12: 9, minute: 45, pm: false });
    expect(latest).toBe(at(2026, 11, 1, 9, 45));
  });

  it("an hour or minutes typed out of range, or left empty, changes nothing until it is right", async () => {
    await render(at(2026, 11, 1, 16, 0));
    await open();
    await type("When: hour", "13");
    expect(latest).toBe(at(2026, 11, 1, 16, 0));
    await type("When: hour", "");
    expect(latest).toBe(at(2026, 11, 1, 16, 0));
    await type("When: minutes", "75");
    expect(latest).toBe(at(2026, 11, 1, 16, 0));
    await type("When: hour", "11");
    expect(decompose(latest!).hour12).toBe(11);
  });

  it("starts at a time worth suggesting when nothing was chosen and a day is picked", async () => {
    await render(null);
    await open();
    const today = new Date(NOW).getDate();
    await act(async () => { day(today + 3).click(); });
    expect(decompose(latest!)).toMatchObject({ day: today + 3, hour12: 1, minute: 0, pm: true }); // 13:00, the next full hour
  });

  it("moves between months, and not before this month or past the last month of the year", async () => {
    await render(at(2026, 10, 25, 16, 0));
    await open();
    expect(q("[data-month-label]").textContent).toBe("November 2026");
    expect((q("button[aria-label='Previous month']") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { q("button[aria-label='Next month']").click(); });
    expect(q("[data-month-label]").textContent).toBe("December 2026");
    expect((q("button[aria-label='Previous month']") as HTMLButtonElement).disabled).toBe(false);
    for (let i = 0; i < 11; i++) await act(async () => { q("button[aria-label='Next month']").click(); });
    expect(q("[data-month-label]").textContent).toBe("November 2027");
    expect((q("button[aria-label='Next month']") as HTMLButtonElement).disabled).toBe(true);
  });

  it("this month: yesterday is greyed out, today and later can be chosen", async () => {
    await render(at(2026, 10, 25, 16, 0));
    await open();
    expect(day(23).disabled).toBe(true);
    expect(day(24).disabled).toBe(false);
    expect(day(25).disabled).toBe(false);
    expect(day(24).getAttribute("aria-current")).toBe("date");
  });

  it("closes with Done and with Escape, and the value stays", async () => {
    await render(at(2026, 11, 1, 16, 0));
    await open();
    await act(async () => { (Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Done") as HTMLElement).click(); });
    expect(panel()).toBeNull();
    await open();
    await act(async () => { panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    expect(panel()).toBeNull();
    expect(latest).toBe(at(2026, 11, 1, 16, 0));
  });

  it("arrow keys move between the days", async () => {
    await render(at(2026, 11, 10, 16, 0));
    await open();
    day(10).focus();
    await act(async () => { day(10).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(day(11));
    await act(async () => { day(11).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(day(18));
  });
});
