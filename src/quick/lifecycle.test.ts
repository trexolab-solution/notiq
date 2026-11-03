import { describe, expect, it } from "vitest";
import { focusTarget, INITIAL_VISIBLE, onVaultState, openOnReady, shouldPollLock } from "./lifecycle";

describe("quick window lifecycle (page side)", () => {
  it("starts hidden, like the window", () => {
    expect(INITIAL_VISIBLE).toBe(false);
  });

  it("treats only an explicit true from quick_search_ready as on screen", () => {
    expect(openOnReady(true)).toBe(true);
    for (const r of [false, undefined, null, "true", 1, {}]) expect(openOnReady(r)).toBe(false);
  });

  it("polls for an unlock only while locked and visible", () => {
    expect(shouldPollLock("locked", true)).toBe(true);
    expect(shouldPollLock("locked", false)).toBe(false); // hidden after a lock: no timers
    expect(shouldPollLock("ready", true)).toBe(false);
  });

  it("never takes the focus while hidden", () => {
    for (const p of ["loading", "ready", "locked", "novault", "error"] as const) {
      expect(focusTarget(p, false)).toBeNull();
    }
    expect(focusTarget("ready", true)).toBe("input");
    expect(focusTarget("locked", true)).toBe("button");
    expect(focusTarget("novault", true)).toBe("button");
  });

  it("a lock always switches to the locked state; an unlock refreshes only a visible window", () => {
    expect(onVaultState({ unlocked: false }, true)).toBe("lock");
    expect(onVaultState({ unlocked: false }, false)).toBe("lock");
    expect(onVaultState({ unlocked: true }, true)).toBe("refresh");
    expect(onVaultState({ unlocked: true }, false)).toBe("ignore");
    expect(onVaultState(null, true)).toBe("ignore");
    expect(onVaultState({ unlocked: "no" }, true)).toBe("ignore");
  });
});
