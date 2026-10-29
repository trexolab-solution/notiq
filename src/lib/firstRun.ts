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
 * True when this launch runs a different version than the last recorded one. Callers
 * must already have ruled out a first-timer (tour not completed): a completed tour with
 * no recorded version is a user who updated from a release that predates this record,
 * and they should get the note too.
 */
export function wasUpdated(current: string = APP_VERSION): boolean {
  return getLastSeenVersion() !== current;
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
