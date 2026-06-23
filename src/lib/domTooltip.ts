// Vanilla-DOM tooltip helper for non-React UI (Monaco content widgets, etc.).
// Reuses the same `.app-tooltip` styling as the React <Tooltip> so they look
// identical. Attach with `attachTooltip(el, "Label")`; returns a disposer.
//
// A single shared tooltip element is portaled to <body>; only one shows at a
// time. Mirrors the React component's hover delay + fast-follow + edge clamping.

const SHOW_DELAY = 550;          // ms before a tooltip appears
const FAST_FOLLOW_WINDOW = 400;  // ms — re-entering this fast skips the delay
const MARGIN = 8;                // viewport edge clamp

let tipEl: HTMLDivElement | null = null;
let labelEl: HTMLSpanElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let lastHideTime = 0;
let isMouseDown = false;

if (typeof document !== "undefined") {
  document.addEventListener("mousedown", () => { isMouseDown = true; }, { capture: true, passive: true });
  document.addEventListener("mouseup",   () => { isMouseDown = false; }, { capture: true, passive: true });
}

function ensureEl(): { tip: HTMLDivElement; label: HTMLSpanElement } {
  if (tipEl && labelEl) return { tip: tipEl, label: labelEl };
  const tip = document.createElement("div");
  tip.className = "app-tooltip";
  tip.style.position = "fixed";
  tip.style.pointerEvents = "none";
  tip.style.display = "none";
  const label = document.createElement("span");
  label.className = "app-tooltip-label";
  tip.appendChild(label);
  document.body.appendChild(tip);
  tipEl = tip;
  labelEl = label;
  return { tip, label };
}

function hide() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  if (tipEl && tipEl.style.display !== "none") {
    tipEl.style.display = "none";
    lastHideTime = Date.now();
  }
}

function show(target: HTMLElement, text: string) {
  if (isMouseDown) return;
  // Don't fight the Monaco find widget (matches React Tooltip behaviour).
  if (document.querySelector(".monaco-editor .find-widget.visible")) return;

  const { tip, label } = ensureEl();
  label.textContent = text;

  const r = target.getBoundingClientRect();
  const above = r.bottom + 52 > window.innerHeight;
  tip.classList.toggle("app-tooltip--above", above);
  tip.style.display = "inline-flex";
  // Measure to clamp horizontally and place vertically.
  let x = r.left + r.width / 2;
  const y = above ? r.top - 10 : r.bottom + 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
  tip.style.transform = above ? "translate(-50%, -100%)" : "translateX(-50%)";

  // Edge-clamp after it has dimensions.
  const tr = tip.getBoundingClientRect();
  if (tr.right > window.innerWidth - MARGIN) {
    x -= tr.right - window.innerWidth + MARGIN;
  } else if (tr.left < MARGIN) {
    x += MARGIN - tr.left;
  }
  tip.style.left = `${x}px`;
}

/**
 * Attach a hover tooltip to a DOM element. Returns a disposer that detaches the
 * listeners (and hides the tooltip if it belongs to this element).
 */
export function attachTooltip(el: HTMLElement, text: string): () => void {
  const onEnter = () => {
    if (isMouseDown) return;
    if (showTimer) clearTimeout(showTimer);
    const elapsed = Date.now() - lastHideTime;
    const delay = elapsed < FAST_FOLLOW_WINDOW ? 0 : SHOW_DELAY;
    showTimer = setTimeout(() => {
      if ((el as HTMLButtonElement).disabled) return;
      show(el, text);
    }, delay);
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
    hide();
  };
}
