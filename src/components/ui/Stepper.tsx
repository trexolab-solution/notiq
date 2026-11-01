import { useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";
import { Check } from "lucide-react";
import { useAnnouncer } from "../../hooks/useAnnouncer";
import { FOCUSABLE, tabbables } from "./useDialogBehaviour";

export interface StepDef<K extends string> {
  key: K;
  label: string;
}

/**
 * Horizontal step indicator for a multi-step dialog: "1 File · 2 Method · 3 Confirm · 4 Done", finished
 * steps show a check and the current one is highlighted and marked `aria-current="step"`. Step changes
 * are announced politely ("Step 2 of 4: Method"). Pass only the steps that apply (see lib/stepper's
 * `activeSteps`); navigation itself is the dialog's job (lib/stepper's `stepperReducer`).
 */
export function Stepper<K extends string>({ steps, current, label = "Progress" }: {
  steps: readonly StepDef<K>[];
  current: K;
  label?: string;
}) {
  const index = Math.max(0, steps.findIndex((s) => s.key === current));
  const { announce, region } = useAnnouncer();
  const first = useRef(true);
  const text = `Step ${index + 1} of ${steps.length}: ${steps[index]?.label ?? ""}`;
  useEffect(() => {
    if (first.current) { first.current = false; return; } // the dialog's own title is read on open
    announce(text);
  }, [text, announce]);

  return (
    <>
      <ol aria-label={label} className="flex items-center gap-1.5 mb-4 text-xs select-none" data-stepper="">
        {steps.map((s, i) => {
          const status = i < index ? "done" : i === index ? "current" : "upcoming";
          return (
            <li key={s.key} aria-current={status === "current" ? "step" : undefined} data-status={status}
                className="flex items-center gap-1.5 min-w-0 flex-1 last:flex-none">
              <span aria-hidden
                    className={`inline-flex items-center justify-center shrink-0 w-5 h-5 rounded-full text-[11px] font-semibold border ${
                      status === "current" ? "bg-[var(--color-primary)] border-[var(--color-primary)] text-[var(--color-bg)]"
                        : status === "done" ? "border-[var(--color-primary)] text-[var(--color-primary)]"
                          : "border-[var(--color-border)] text-[var(--color-text-muted)]"}`}>
                {status === "done" ? <Check size={11} strokeWidth={3} /> : i + 1}
              </span>
              <span className={`whitespace-nowrap ${status === "current" ? "font-semibold text-[var(--color-text)]" : "text-[var(--color-text-muted)]"}`}>
                {s.label}
                {status === "done" && <span className="sr-only"> (completed)</span>}
              </span>
              {i < steps.length - 1 && (
                <span aria-hidden className={`h-px flex-1 min-w-3 ${i < index ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`} />
              )}
            </li>
          );
        })}
      </ol>
      {region}
    </>
  );
}

/**
 * Moves focus to the first control of the step inside `rootRef` whenever `step` changes. On the first
 * render it only does so when focus isn't already inside (the dialog may have placed it). A
 * `[data-step-focus]` element wins over the first tabbable.
 */
export function useStepFocus(rootRef: RefObject<HTMLElement | null>, step: string) {
  const prev = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (prev.current === step) return;
    const initial = prev.current === null;
    prev.current = step;
    const root = rootRef.current;
    if (!root || (initial && root.contains(document.activeElement))) return;
    const target = root.querySelector<HTMLElement>("[data-step-focus]")
      ?? tabbables(root)[0]
      // No layout (tests, a hidden pane): fall back to the first focusable by markup alone.
      ?? [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].find((el) => el.tabIndex >= 0);
    target?.focus({ preventScroll: true });
  }, [rootRef, step]);
}
