/** How often the app looks for a new version while it's running (it can sit in the tray for days). */
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Whether a background check may run now. Never while one is in flight, while a download/restart is
 * under way, or once an update is already waiting (the pill/dialog hold that Update handle).
 */
export function canAutoCheck(status: string): boolean {
  return !["checking", "downloading", "ready", "available"].includes(status);
}
