import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useAppStore } from "../store";
import { useVaultStore } from "../store/vaultStore";
import { toast } from "../lib/toast";
import { isTauri } from "../lib/tauriWindow";
import { getLockOnSession, shouldLockOnSession } from "../lib/vaultPrefs";
import { VAULT_HIDE_SECRETS_EVENT } from "./useAutoHide";

/** Payload of the `vault:session-lock` event emitted by src-tauri/src/session_lock.rs. */
export interface SessionLockPayload { reason: "lock" | "suspend" | "disconnect" }

/** Locks the vault when Windows locks the session, the PC sleeps, or a remote session disconnects. */
export function useVaultSessionLock() {
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<SessionLockPayload>("vault:session-lock", async (e) => {
      if (!shouldLockOnSession(getLockOnSession(), useVaultStore.getState().unlocked)) return;
      // Hide revealed secrets first so nothing stays visible if saving blocks the lock.
      window.dispatchEvent(new Event(VAULT_HIDE_SECRETS_EVENT));
      const ok = await useAppStore.getState().lockVault();
      if (ok) toast.info(e.payload?.reason === "suspend" ? "Vault locked: computer went to sleep" : "Vault locked: Windows session locked");
    })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; })
      .catch((err) => console.warn("vault: couldn't listen for session lock", err));
    return () => { cancelled = true; unlisten?.(); };
  }, []);
}
