// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "./Button";
import { DialogButton } from "./DialogParts";
import { BusyIcon, InlineLoading, Spinner, busyIconProps, LOADING_SHOW_DELAY_MS, LOADING_SLOW_AFTER_MS } from "./Loading";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = async (ui: React.ReactNode) => { await act(async () => { root.render(ui); }); };
const q = <T extends Element = HTMLElement>(sel: string) => host.querySelector<T>(sel);
const widthOf = (label: string) => label.length * 7 + 24;

// happy-dom has no layout: give elements a width that follows their text, like a browser would.
const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

beforeEach(() => {
  rectSpy.mockImplementation(function (this: HTMLElement) {
    const w = widthOf(this.textContent ?? "");
    return { width: w, height: 24, top: 0, left: 0, right: w, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Button loading", () => {
  const ui = (loading: boolean) => (
    <Button icon={<Download size={12} data-testid="lead" />} loading={loading} loadingText="Syncing…">Sync now and more</Button>
  );

  it("swaps the label, replaces the icon with a spinner, disables and sets aria-busy", async () => {
    await render(ui(false));
    const b = q<HTMLButtonElement>("button")!;
    expect(b.textContent).toBe("Sync now and more");
    expect(b.disabled).toBe(false);
    expect(b.hasAttribute("aria-busy")).toBe(false);
    expect(q('[data-testid="lead"]')).not.toBeNull();

    await render(ui(true));
    expect(b.textContent).toBe("Syncing…");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(q('[data-testid="lead"]')).toBeNull();
    expect(b.querySelector("svg.nq-spinner")).not.toBeNull();
  });

  it("keeps its idle width while busy (a shorter busy label can't shrink it) and lets go after", async () => {
    await render(ui(false));
    const b = q<HTMLButtonElement>("button")!;
    await render(ui(true));
    expect(b.style.minWidth).toBe(`${widthOf("Sync now and more")}px`);
    await render(ui(false));
    expect(b.style.minWidth).toBe("");
  });

  it("without loadingText keeps the normal label; prepends the spinner when there's no icon", async () => {
    await render(<Button loading>Save</Button>);
    const b = q<HTMLButtonElement>("button")!;
    expect(b.textContent).toBe("Save");
    expect(b.querySelector("svg.nq-spinner")).not.toBeNull();
  });

  it("the plain API is unchanged: no busy attributes, no min-width, disabled + style pass through", async () => {
    await render(<Button disabled style={{ color: "red" }}>Plain</Button>);
    const b = q<HTMLButtonElement>("button")!;
    expect(b.disabled).toBe(true);
    expect(b.hasAttribute("aria-busy")).toBe(false);
    expect(b.style.minWidth).toBe("");
    expect(b.style.color).toBe("red");
  });
});

describe("DialogButton loading", () => {
  it("swaps label + icon, disables, aria-busy, keeps width, still forwards its ref", async () => {
    const ref = { current: null as HTMLButtonElement | null };
    const ui = (loading: boolean) => (
      <DialogButton ref={ref} variant="primary" loading={loading} loadingText="Opening…">Open vault</DialogButton>
    );
    await render(ui(false));
    const b = q<HTMLButtonElement>("button")!;
    expect(ref.current).toBe(b);
    await render(ui(true));
    expect(b.textContent).toBe("Opening…");
    expect(b.disabled).toBe(true);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.style.minWidth).toBe(`${widthOf("Open vault")}px`);
    expect(ref.current).toBe(b);
  });
});

describe("InlineLoading", () => {
  it("shows nothing until the delay passes, then spinner + label as a status", async () => {
    vi.useFakeTimers();
    await render(<InlineLoading label="Checking your Google Drive…" />);
    expect(q('[role="status"]')).toBeNull();
    expect(host.textContent).toBe("");
    await act(async () => { vi.advanceTimersByTime(LOADING_SHOW_DELAY_MS - 1); });
    expect(q('[role="status"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    const s = q('[role="status"]')!;
    expect(s.textContent).toBe("Checking your Google Drive…");
    expect(s.querySelector("svg.nq-spinner")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("a fast operation (gone before the delay) never flashes", async () => {
    vi.useFakeTimers();
    await render(<InlineLoading label="Loading…" />);
    await act(async () => { vi.advanceTimersByTime(100); });
    await render(null);
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(host.textContent).toBe("");
  });

  it("adds the slow hint only after slowAfter", async () => {
    vi.useFakeTimers();
    await render(<InlineLoading label="Checking…" slowHint="Still working." />);
    await act(async () => { vi.advanceTimersByTime(LOADING_SHOW_DELAY_MS); });
    expect(host.textContent).toBe("Checking…");
    await act(async () => { vi.advanceTimersByTime(LOADING_SLOW_AFTER_MS); });
    expect(host.textContent).toContain("Still working.");
  });

  it("delay 0 shows at once; reserveSpace keeps an invisible, hidden placeholder meanwhile", async () => {
    vi.useFakeTimers();
    await render(<InlineLoading label="Now" delay={0} />);
    expect(q('[role="status"]')!.textContent).toBe("Now");
    await render(<InlineLoading key="b" label="Later" reserveSpace />);
    const ph = q("[data-pending]")!;
    expect(ph.getAttribute("aria-hidden")).toBe("true");
    expect(ph.className).toContain("invisible");
    expect(q('[role="status"]')).toBeNull();
  });
});

describe("icon-only busy controls", () => {
  it("busyIconProps switches the accessible name + tooltip and sets aria-busy only while busy", () => {
    expect(busyIconProps(false, "Refresh models", "Loading models…"))
      .toEqual({ "aria-label": "Refresh models", "aria-busy": undefined, tooltip: "Refresh models" });
    expect(busyIconProps(true, "Refresh models", "Loading models…"))
      .toEqual({ "aria-label": "Loading models…", "aria-busy": true, tooltip: "Loading models…" });
  });

  it("a busy icon button is named by its busy text, never a bare spinner", async () => {
    const p = busyIconProps(true, "Restore", "Restoring…");
    await render(
      <button type="button" aria-label={p["aria-label"]} aria-busy={p["aria-busy"]}><BusyIcon icon={Download} busy /></button>,
    );
    const b = q("button")!;
    expect(b.getAttribute("aria-label")).toBe("Restoring…");
    expect(b.getAttribute("aria-busy")).toBe("true");
    // The glyph is decorative: the name lives on the button.
    expect(b.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(b.querySelector("svg.nq-spinner")).not.toBeNull();
  });

  it("spinSelf icons rotate in place instead of being swapped", async () => {
    await render(<BusyIcon icon={RefreshCw} busy spinSelf size={11} />);
    const svg = q("svg")!;
    expect(svg.classList.contains("nq-spin")).toBe(true);
    expect(svg.classList.contains("nq-spinner")).toBe(false);
    await render(<BusyIcon icon={RefreshCw} spinSelf size={11} />);
    expect(q("svg")!.classList.contains("nq-spin")).toBe(false);
  });
});

describe("Spinner", () => {
  it("is decorative without a label and a named image with one", async () => {
    await render(<Spinner />);
    expect(q("svg")!.getAttribute("aria-hidden")).toBe("true");
    await render(<Spinner label="Loading" />);
    const svg = q("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Loading");
    expect(svg.hasAttribute("aria-hidden")).toBe(false);
  });

  it("rotates normally and pulses instead under prefers-reduced-motion", async () => {
    await render(<Spinner />);
    expect(q("svg")!.classList.contains("nq-spin")).toBe(true);
    await render(null);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"), media: query, addEventListener: () => {}, removeEventListener: () => {},
    }));
    await render(<Spinner />);
    const svg = q("svg")!;
    expect(svg.classList.contains("nq-pulse")).toBe(true);
    expect(svg.classList.contains("nq-spin")).toBe(false);
    expect(svg.hasAttribute("data-reduced-motion")).toBe(true);
  });
});
