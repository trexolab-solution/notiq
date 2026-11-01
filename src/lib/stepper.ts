/**
 * Pure step navigation for multi-step dialogs (wizards). A flow is a fixed, ordered list of step keys;
 * some may be skipped for the current situation (e.g. "method" when there is nothing to choose between).
 * Rendering lives in components/ui/Stepper.tsx; a dialog keeps its own form state and moves with these.
 */

export interface StepperFlow<K extends string> {
  /** Every step, in order. */
  steps: readonly K[];
  /** Steps that don't apply right now; they are passed over and hidden from the indicator. */
  skipped?: readonly K[];
}

export type StepperAction<K extends string> =
  /** Forward, only when the current step is complete (`canAdvance`). */
  | { type: "next"; canAdvance: boolean }
  | { type: "back" }
  /** Jump to a step that applies (e.g. "done" after the action ran). */
  | { type: "goto"; step: K };

/** The steps that apply, in order. */
export function activeSteps<K extends string>(flow: StepperFlow<K>): K[] {
  const skip = new Set(flow.skipped ?? []);
  return flow.steps.filter((k) => !skip.has(k));
}

/** The next applicable step after `current`, or `current` when it is the last one. */
export function stepAfter<K extends string>(flow: StepperFlow<K>, current: K): K {
  const skip = new Set(flow.skipped ?? []);
  const i = flow.steps.indexOf(current);
  for (let j = i + 1; j < flow.steps.length; j++) if (!skip.has(flow.steps[j])) return flow.steps[j];
  return current;
}

/** The previous applicable step before `current`, or `current` when it is the first one. */
export function stepBefore<K extends string>(flow: StepperFlow<K>, current: K): K {
  const skip = new Set(flow.skipped ?? []);
  const i = flow.steps.indexOf(current);
  for (let j = i - 1; j >= 0; j--) if (!skip.has(flow.steps[j])) return flow.steps[j];
  return current;
}

/** Where `step` sits relative to `current` among the applicable steps. */
export function stepStatus<K extends string>(flow: StepperFlow<K>, current: K, step: K): "done" | "current" | "upcoming" {
  const order = activeSteps(flow);
  const a = order.indexOf(step);
  const c = order.indexOf(current);
  return a === c ? "current" : a < c ? "done" : "upcoming";
}

/**
 * The step after `action`: forward only when allowed, back never before the first step, jumps only to
 * steps that apply. A step that has become skipped (the situation changed) moves on to the next one.
 */
export function stepperReducer<K extends string>(flow: StepperFlow<K>, current: K, action: StepperAction<K>): K {
  const skip = new Set(flow.skipped ?? []);
  let next = current;
  if (action.type === "next") next = action.canAdvance ? stepAfter(flow, current) : current;
  else if (action.type === "back") next = stepBefore(flow, current);
  else if (flow.steps.includes(action.step) && !skip.has(action.step)) next = action.step;
  if (skip.has(next)) next = stepAfter(flow, next);
  return next;
}
