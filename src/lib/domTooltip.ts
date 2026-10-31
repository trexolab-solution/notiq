// Vanilla-DOM tooltip helper for non-React UI (Monaco content widgets, etc.).
// Reuses the same `.app-tooltip` styling, timing (warm-up / cool-down) and
// placement as the React <Tooltip>, so they look and behave identically.
// Attach with `attachTooltip(el, "Label")`; returns a disposer.
//
// A single shared tooltip element is portaled to <body>; the shared runtime
// guarantees only one tooltip (React or DOM) shows at a time.

import { placeTooltip } from "./popoverPosition";
import { isMouseDown, tooltipRuntime } from "./tooltipLogic";

let tipEl: HTMLDivElement | null = null;
let labelEl: HTMLSpanElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let owner: HTMLElement | null = null;

function ensureEl(): { tip: HTMLDivElement; label: HTMLSpanElement } {
  if (tipEl && labelEl) return { tip: tipEl, label: labelEl };
  const tip = document.createElement("div");
  tip.className = "app-tooltip";
  tip.setAttribute("role", "tooltip");
  tip.id = "app-dom-tooltip";
  tip.style.position = "fixed";
  tip.style.pointerEvents = "none";
  tip.style.display = "none";
  const row = document.createElement("div");
  row.className = "app-tooltip-row";
  const label = document.createElement("span");
  label.className = "app-tooltip-label";
  row.appendChild(label);
  tip.appendChild(row);
  document.body.appendChild(tip);
  tipEl = tip;
  labelEl = label;
  return { tip, label };
}

const onGlobalKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };

function listen(on: boolean) {
  const m = on ? "addEventListener" : "removeEventListener";
  document[m]("keydown", onGlobalKey as EventListener, true);
  document[m]("pointerdown", hide, true);
  window[m]("scroll", hide, true);
  window[m]("resize", hide);
  window[m]("blur", hide);
}

function hide() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  if (tipEl && tipEl.style.display !== "none") {
    tipEl.style.display = "none";
    owner?.removeAttribute("aria-describedby");
    owner = null;
    listen(false);
    tooltipRuntime.hidden(hide);
  }
}

function show(target: HTMLElement, text: string) {
  if (isMouseDown()) return;
  // Don't fight the Monaco find widget (matches React Tooltip behaviour).
  if (document.querySelector(".monaco-editor .find-widget.visible")) return;

  const { tip, label } = ensureEl();
  const wasOpen = tip.style.display !== "none";
  label.textContent = text;
  tip.style.visibility = "hidden";
  tip.style.display = "block";
  tip.style.left = "0px";
  tip.style.top = "0px";

  const size = tip.getBoundingClientRect();
  const pos = placeTooltip(target.getBoundingClientRect(), { width: size.width, height: size.height },
    { width: window.innerWidth, height: window.innerHeight });
  tip.className = `app-tooltip app-tooltip--${pos.placement}`;
  tip.style.left = `${pos.left}px`;
  tip.style.top = `${pos.top}px`;
  tip.style.visibility = "";

  owner?.removeAttribute("aria-describedby");
  owner = target;
  target.setAttribute("aria-describedby", tip.id);
  if (!wasOpen) listen(true);
  tooltipRuntime.shown(hide);
}

/**
 * Attach a hover tooltip to a DOM element. Returns a disposer that detaches the
 * listeners (and hides the tooltip if it belongs to this element).
 */
export function attachTooltip(el: HTMLElement, text: string): () => void {
  const onEnter = () => {
    if (isMouseDown()) return;
    if (showTimer) clearTimeout(showTimer);
    const run = () => {
      showTimer = null;
      if ((el as HTMLButtonElement).disabled || !el.isConnected) return;
      show(el, text);
    };
    const delay = tooltipRuntime.delayFor();
    if (delay === 0) run();
    else showTimer = setTimeout(run, delay);
  };
  const onLeave = () => hide();
  const onDown = () => hide();

  el.addEventListener("mouseenter", onEnter);
  el.addEventListener("mouseleave", onLeave);
  el.addEventListener("mousedown", onDown);

  return () => {
    el.removeEventListener("mouseenter", onEnter);
    el.removeEventListener("mouseleave", onLeave);
    el.removeEventListener("mousedown", onDown);
    if (owner === el || !owner) hide();
  };
}
