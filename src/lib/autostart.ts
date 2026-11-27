import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

/**
 * localStorage key tracking whether we have run the first-launch auto-enable.
 * Once set, we never silently re-enable — the user's Settings toggle is
 * authoritative from then on.
 */
const FIRST_RUN_KEY = "autostart:firstRunDone";

/**
 * Launch at sign-in is on by default: the first launch of an installed build
 * enables it. Once that has worked, later launches are no-ops (a failed try is
 * repeated next time); the user can still toggle the setting from the Settings → General
 * panel.
 */
export async function bootstrapAutostart(): Promise<void> {
  // A dev build must not register itself (the debug exe) to start with the OS.
  if (import.meta.env.DEV) return;
  if (localStorage.getItem(FIRST_RUN_KEY)) return;
  try {
    await enable();
    localStorage.setItem(FIRST_RUN_KEY, "1");
  } catch (err) {
    console.warn("autostart: enable on first run failed", err);
  }
}

export { enable, disable, isEnabled };
