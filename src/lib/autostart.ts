import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";

/**
 * localStorage key tracking whether we have run the first-launch auto-enable.
 * Once set, we never silently re-enable — the user's Settings toggle is
 * authoritative from then on.
 */
const FIRST_RUN_KEY = "autostart:firstRunDone";

/**
 * On the very first launch of an installed build, enable auto-start so the
 * app comes back automatically on the next sign-in. Subsequent launches are
 * no-ops; the user can still toggle the setting from the Settings → General
 * panel.
 */
export async function bootstrapAutostart(): Promise<void> {
  if (localStorage.getItem(FIRST_RUN_KEY)) return;
  try {
    await enable();
  } catch (err) {
    // Auto-start may legitimately fail in dev / portable builds — log and
    // mark the bootstrap done so we don't keep retrying every reload.
    console.warn("autostart: enable on first run failed", err);
  }
  localStorage.setItem(FIRST_RUN_KEY, "1");
}

export { enable, disable, isEnabled };
