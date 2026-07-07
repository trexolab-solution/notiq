import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { TOUR_STEPS, type TourPlacement, type TourStep } from "./tourSteps";
import { markTourCompleted } from "../../lib/firstRun";

/**
 * First-run welcome tour — a custom, theme-aware spotlight overlay (no external
 * dependency). Dims the app, cuts a highlight "hole" over the current landmark
 * (via a big box-shadow), and anchors a popover next to it. Lazy-loaded from
 * `App.tsx`, mounted only while active.
 */
interface TourProps {
  onClose: () => void;
}

interface Pos {
  top: number;
  left: number;
}

const GAP = 12;      // space between target and popover
const MARGIN = 8;    // keep popover this far from viewport edges
const PAD = 6;       // spotlight padding around the target
const POPOVER_W = 320;

/** Compute a viewport-clamped popover position for the given target rect. */
function place(rect: DOMRect | null, placement: TourPlacement, popH: number): Pos {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (!rect || placement === "center") {
    return { top: Math.max(MARGIN, vh / 2 - popH / 2), left: Math.max(MARGIN, vw / 2 - POPOVER_W / 2) };
  }

  let top: number;
  let left: number;
  switch (placement) {
    case "top":
      top = rect.top - popH - GAP;
      left = rect.left + rect.width / 2 - POPOVER_W / 2;
      break;
    case "left":
      left = rect.left - POPOVER_W - GAP;
      top = rect.top + rect.height / 2 - popH / 2;
      break;
    case "right":
      left = rect.right + GAP;
      top = rect.top + rect.height / 2 - popH / 2;
      break;
    case "bottom":
    default:
      top = rect.bottom + GAP;
      left = rect.left + rect.width / 2 - POPOVER_W / 2;
      break;
  }

  left = Math.max(MARGIN, Math.min(left, vw - POPOVER_W - MARGIN));
  top = Math.max(MARGIN, Math.min(top, vh - popH - MARGIN));
  return { top, left };
}

export default function Tour({ onClose }: TourProps) {
  // Keep only steps whose anchor is actually mounted (center steps always stay).
  // Computed once on mount — the app layout is already rendered by then.
  const [steps] = useState<TourStep[]>(() =>
    TOUR_STEPS.filter((s) => !s.selector || document.querySelector(s.selector)),
  );
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [pos, setPos] = useState<Pos>({ top: -9999, left: -9999 });
  const popoverRef = useRef<HTMLDivElement>(null);

  const step = steps[index];
  const isLast = index === steps.length - 1;

  const finish = useCallback(() => {
    markTourCompleted();
    onClose();
  }, [onClose]);

  const next = useCallback(() => {
    if (isLast) finish();
    else setIndex((i) => i + 1);
  }, [isLast, finish]);

  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  // Measure the current target and (re)position the popover. Re-runs on step
  // change, window resize, scroll, and target resize. useLayoutEffect so the
  // first paint is already positioned (no flash at -9999).
  useLayoutEffect(() => {
    if (!step) return;
    const target = step.selector
      ? (document.querySelector(step.selector) as HTMLElement | null)
      : null;

    const update = () => {
      const r = target ? target.getBoundingClientRect() : null;
      setRect(r);
      const popH = popoverRef.current?.offsetHeight ?? 180;
      setPos(place(r, step.placement ?? "bottom", popH));
    };
    update();

    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    let ro: ResizeObserver | undefined;
    if (target && "ResizeObserver" in window) {
      ro = new ResizeObserver(update);
      ro.observe(target);
    }
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      ro?.disconnect();
    };
  }, [step]);

  // Keyboard navigation: Esc skips, →/Enter advances, ← goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [next, back, finish]);

  if (!step) return null;

  const spotStyle = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : undefined;

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="Welcome tour">
      {rect ? <div className="tour-spotlight" style={spotStyle} /> : <div className="tour-dim" />}

      <div ref={popoverRef} className="tour-popover" style={{ top: pos.top, left: pos.left, width: POPOVER_W }}>
        <button className="tour-close" aria-label="Skip tour" onClick={finish}>
          <X size={15} />
        </button>

        <h3 className="tour-title">{step.title}</h3>
        <p className="tour-body">{step.body}</p>

        <div className="tour-footer">
          <div className="tour-dots" aria-hidden="true">
            {steps.map((_, i) => (
              <span key={i} className={`tour-dot${i === index ? " is-active" : ""}`} />
            ))}
          </div>
          <div className="tour-actions">
            {index > 0 && (
              <button className="tour-btn tour-btn--ghost" onClick={back}>
                <ArrowLeft size={13} /> Back
              </button>
            )}
            {isLast ? (
              <button className="tour-btn tour-btn--primary" onClick={finish}>
                <Check size={13} /> Done
              </button>
            ) : (
              <button className="tour-btn tour-btn--primary" onClick={next}>
                Next <ArrowRight size={13} />
              </button>
            )}
          </div>
        </div>

        {!isLast && (
          <button className="tour-skip" onClick={finish}>Skip tour</button>
        )}
      </div>
    </div>
  );
}
