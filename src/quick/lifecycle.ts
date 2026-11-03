/**
 * Page side of the quick window's lifecycle (pure, see quick_search.rs for the Rust side).
 *
 * The window is created hidden and only Rust decides when it is on screen (hotkey / reopen after the
 * popup's own Unlock). The page therefore starts as "not visible", never grabs the focus while hidden,
 * and follows Rust's `quick-search:shown` / `quick-search:hidden` events.
 */

export type QuickPhase = "loading" | "ready" | "locked" | "novault" | "error";

/** The window is created hidden: nothing (2FA timers, lock polling, focus) runs until a show. */
export const INITIAL_VISIBLE = false;

/**
 * `quick_search_ready` answers whether the window is on screen (a show the user asked for). True at
 * mount means the page missed that show's `shown` event (the show timed out waiting for it), so it
 * must act as if it had received it. Anything else (old backend, error) means hidden.
 */
export function openOnReady(reply: unknown): boolean {
  return reply === true;
}

/** While locked and on screen, look for the unlock done in the main window. Never while hidden. */
export function shouldPollLock(phase: QuickPhase, visible: boolean): boolean {
  return phase === "locked" && visible;
}

/** What gets the keyboard focus: nothing while hidden, the search box when ready, else the button. */
export function focusTarget(phase: QuickPhase, visible: boolean): "input" | "button" | null {
  if (!visible) return null;
  return phase === "ready" ? "input" : "button";
}

/**
 * A `vault:state-changed` event: a lock always drops the list and the codes (hidden or not, so a
 * later show starts in the locked state, never blank); an unlock refreshes only a visible window
 * (a hidden one refreshes on its next show).
 */
export function onVaultState(payload: unknown, visible: boolean): "lock" | "refresh" | "ignore" {
  const unlocked = (payload as { unlocked?: unknown } | null)?.unlocked;
  if (unlocked === false) return "lock";
  if (unlocked === true && visible) return "refresh";
  return "ignore";
}
