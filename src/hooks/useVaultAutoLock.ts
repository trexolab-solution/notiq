import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { useVaultStore } from "../store/vaultStore";
import { toast } from "../lib/toast";
import { isTauri } from "../lib/tauriWindow";
import { getIdleMinutes, getLockOnHide } from "../lib/vaultPrefs";

/** How often we compare "now" with the last user activity. */
const CHECK_MS = 15_000;
const ACTIVITY_EVENTS = ["keydown", "mousedown", "mousemove", "wheel", "touchstart"] as const;

/**
 * Secure Vault auto-lock. While the vault is unlocked:
 *  - locks after the configured idle time (Settings → Vault; default 5 min);
 *  - locks when the main window is closed to the tray (if enabled).
 * The idle check compares timestamps, so it also fires right after the computer
 * wakes from sleep (the interval is late, the elapsed time is large).
 */
export function useVaultAutoLock() {
  const unlocked = useVaultStore((s) => s.unlocked);

  // Idle timeout
  useEffect(() => {
    if (!unlocked) return;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    ACTIVITY_EVENTS.forEach((ev) => window.addEventListener(ev, bump, { passive: true, capture: true }));

    const timer = setInterval(() => {
      const minutes = getIdleMinutes();
      if (minutes <= 0) return;
      if (Date.now() - last >= minutes * 60_000) {
        last = Date.now(); // avoid re-trigger loops if locking fails (e.g. a save error)
        void useAppStore.getState().lockVault().then((ok) => {
          if (ok) toast.info(`Vault locked after ${minutes} min of inactivity`);
        });
      }
    }, CHECK_MS);

    return () => {
      clearInterval(timer);
      ACTIVITY_EVENTS.forEach((ev) => window.removeEventListener(ev, bump, { capture: true }));
    };
  }, [unlocked]);

  // Window closed to tray
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("vault-window-hidden", () => {
      if (!getLockOnHide()) return;
      if (!useVaultStore.getState().unlocked) return;
      void useAppStore.getState().lockVault();
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch((e) => console.warn("vault: couldn't listen for window hide", e));
    return () => { cancelled = true; unlisten?.(); };
  }, []);
}
