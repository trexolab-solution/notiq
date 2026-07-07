import { APP_VERSION } from "../config/app";

/**
 * First-run / release-awareness gates.
 *
 * Deliberately standalone `localStorage` (mirrors `lib/autostart.ts`) rather than
 * the `store/preferences.ts` registry, so that Settings → "Reset Preferences"
 * does NOT re-trigger the welcome tour or re-show the "What's New" note.
 */

const LAST_SEEN_VERSION_KEY = "whatsnew:lastSeenVersion";
const TOUR_DONE_KEY = "tour:completed";

/** The app version recorded on a previous launch, or null if never recorded. */
export function getLastSeenVersion(): string | null {
  try { return localStorage.getItem(LAST_SEEN_VERSION_KEY); }
  catch { return null; }
}

/** Persist the current version as "seen" (call after deciding what to show). */
export function recordSeenVersion(version: string = APP_VERSION): void {
  try { localStorage.setItem(LAST_SEEN_VERSION_KEY, version); }
  catch { /* private-mode / storage disabled — ignore */ }
}

/**
 * True only when a *previous, different* version was recorded — i.e. the app was
 * genuinely updated. A fresh install (or a pre-feature user with no stored
 * version) returns false, so the "What's New" note never greets a first-timer.
 */
export function wasUpdated(current: string = APP_VERSION): boolean {
  const seen = getLastSeenVersion();
  return seen !== null && seen !== current;
}

/** Whether the first-run welcome tour has been completed or skipped. */
export function isTourCompleted(): boolean {
  try { return localStorage.getItem(TOUR_DONE_KEY) === "true"; }
  catch { return true; } // storage unavailable → don't nag
}

/** Mark the welcome tour done (finished or skipped) so it won't auto-open again. */
export function markTourCompleted(): void {
  try { localStorage.setItem(TOUR_DONE_KEY, "true"); }
  catch { /* ignore */ }
}

/** Clear the tour-completed flag (e.g. for testing a fresh first run). */
export function resetTour(): void {
  try { localStorage.removeItem(TOUR_DONE_KEY); }
  catch { /* ignore */ }
}
