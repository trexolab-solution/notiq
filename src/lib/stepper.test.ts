import { describe, expect, it } from "vitest";
import { activeSteps, stepAfter, stepBefore, stepperReducer, stepStatus, type StepperFlow } from "./stepper";

type K = "a" | "b" | "c" | "d";
const all: StepperFlow<K> = { steps: ["a", "b", "c", "d"] };
const noB: StepperFlow<K> = { steps: ["a", "b", "c", "d"], skipped: ["b"] };

describe("stepper", () => {
  it("lists only the steps that apply", () => {
    expect(activeSteps(all)).toEqual(["a", "b", "c", "d"]);
    expect(activeSteps(noB)).toEqual(["a", "c", "d"]);
  });

  it("moves forward only when the step is complete, and never past the end", () => {
    expect(stepperReducer(all, "a", { type: "next", canAdvance: false })).toBe("a");
    expect(stepperReducer(all, "a", { type: "next", canAdvance: true })).toBe("b");
    expect(stepperReducer(all, "d", { type: "next", canAdvance: true })).toBe("d");
  });

  it("goes back one step, never before the first", () => {
    expect(stepperReducer(all, "c", { type: "back" })).toBe("b");
    expect(stepperReducer(all, "a", { type: "back" })).toBe("a");
  });

  it("passes over skipped steps both ways", () => {
    expect(stepAfter(noB, "a")).toBe("c");
    expect(stepBefore(noB, "c")).toBe("a");
    expect(stepperReducer(noB, "a", { type: "next", canAdvance: true })).toBe("c");
    expect(stepperReducer(noB, "c", { type: "back" })).toBe("a");
  });

  it("jumps only to steps that apply; a current step that became skipped moves on", () => {
    expect(stepperReducer(all, "a", { type: "goto", step: "d" })).toBe("d");
    expect(stepperReducer(noB, "a", { type: "goto", step: "b" })).toBe("a");
    expect(stepperReducer(noB, "b", { type: "next", canAdvance: false })).toBe("c");
  });

  it("reports done / current / upcoming among the applicable steps", () => {
    expect(stepStatus(noB, "c", "a")).toBe("done");
    expect(stepStatus(noB, "c", "c")).toBe("current");
    expect(stepStatus(noB, "c", "d")).toBe("upcoming");
  });
});
