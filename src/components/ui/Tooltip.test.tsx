// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Tooltip } from "./Tooltip";
import { tooltipRuntime } from "../../lib/tooltipLogic";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const tip = () => document.querySelector<HTMLElement>('[role="tooltip"]');
const btn = (label = "a") => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const fire = (el: EventTarget, ev: Event) => act(() => { el.dispatchEvent(ev); });
const enter = (el: Element) => fire(el, new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
const leave = (el: Element) => fire(el, new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

const render = (ui: React.ReactNode) => act(() => { root.render(ui); });
const two = () => render(
  <>
    <Tooltip content="New note" shortcut="Ctrl+N"><button aria-label="a">A</button></Tooltip>
    <Tooltip content="Save" description="Writes to disk"><button aria-label="b">B</button></Tooltip>
  </>,
);

beforeEach(() => {
  vi.useFakeTimers();
  tooltipRuntime.reset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  // Leave the modality tracker in "mouse up" state for the next test.
  document.dispatchEvent(new MouseEvent("mouseup"));
});

describe("Tooltip", () => {
  it("shows after the 500 ms delay and hides on pointer leave", async () => {
    await two();
    await enter(btn());
    await advance(499);
    expect(tip()).toBeNull();
    await advance(1);
    expect(tip()?.textContent).toContain("New note");
    await leave(btn());
    expect(tip()).toBeNull();
  });

  it("renders the shortcut as keybinding chips and a description line", async () => {
    await two();
    await enter(btn());
    await advance(500);
    const keys = [...tip()!.querySelectorAll("kbd")].map((k) => k.textContent);
    expect(keys).toEqual(["Ctrl", "N"]);
    await leave(btn());
    await enter(btn("b"));
    expect(tip()!.querySelector(".app-tooltip-desc")?.textContent).toBe("Writes to disk");
  });

  it("is instant on an adjacent trigger while warm, then cools down", async () => {
    await two();
    await enter(btn());
    await advance(500);
    await leave(btn());
    await enter(btn("b"));
    expect(tip()?.textContent).toContain("Save"); // no delay
    await leave(btn("b"));
    await advance(1000); // cooled down
    await enter(btn());
    expect(tip()).toBeNull();
    await advance(500);
    expect(tip()).not.toBeNull();
  });

  it("wires aria-describedby only while visible, keeping an existing one", async () => {
    await render(
      <Tooltip content="Hi"><button aria-label="a" aria-describedby="hint">A</button></Tooltip>,
    );
    expect(btn().getAttribute("aria-describedby")).toBe("hint");
    await enter(btn());
    await advance(500);
    const id = tip()!.id;
    expect(id).toBeTruthy();
    expect(btn().getAttribute("aria-describedby")).toBe(`hint ${id}`);
    await leave(btn());
    expect(btn().getAttribute("aria-describedby")).toBe("hint");
  });

  it("hides on Escape", async () => {
    await two();
    await enter(btn());
    await advance(500);
    await fire(document, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(tip()).toBeNull();
  });

  it("hides on window blur, scroll and pointer-down", async () => {
    await two();
    for (const ev of [() => new Event("blur"), () => new Event("scroll")]) {
      await enter(btn());
      await advance(500);
      expect(tip()).not.toBeNull();
      await fire(window, ev());
      expect(tip()).toBeNull();
      await leave(btn());
      await advance(1000);
    }
    await enter(btn());
    await advance(500);
    await fire(btn(), new MouseEvent("mousedown", { bubbles: true }));
    expect(tip()).toBeNull();
  });

  it("shows on keyboard focus and hides on blur", async () => {
    await two();
    await fire(document, new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    await act(() => { btn().focus(); });
    await advance(500);
    expect(tip()?.textContent).toContain("New note");
    expect(document.activeElement).toBe(btn()); // never steals focus
    await act(() => { btn().blur(); });
    expect(tip()).toBeNull();
  });

  it("only one tooltip is visible at a time", async () => {
    await two();
    await enter(btn());
    await advance(500);
    await enter(btn("b")); // no leave in between (e.g. keyboard + mouse)
    expect(document.querySelectorAll('[role="tooltip"]').length).toBe(1);
    expect(tip()?.textContent).toContain("Save");
  });

  it("is suppressed when disabled or the trigger is disabled", async () => {
    await render(
      <>
        <Tooltip content="X" disabled><button aria-label="a">A</button></Tooltip>
        <Tooltip content="Y"><button aria-label="b" disabled>B</button></Tooltip>
      </>,
    );
    await enter(btn());
    await enter(btn("b"));
    await advance(1000);
    expect(tip()).toBeNull();
  });

  it("composes the child's own handlers", async () => {
    const onMouseEnter = vi.fn();
    const onFocus = vi.fn();
    await render(<Tooltip content="Z"><button aria-label="a" onMouseEnter={onMouseEnter} onFocus={onFocus}>A</button></Tooltip>);
    await enter(btn());
    await act(() => { btn().focus(); });
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
